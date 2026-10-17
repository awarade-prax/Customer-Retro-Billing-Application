import Controller from "sap/ui/core/mvc/Controller";
import Sorter from "sap/ui/model/Sorter";
import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import Event from "sap/ui/base/Event";
import JSONModel from "sap/ui/model/json/JSONModel";
import Table, { Table$RowSelectionChangeEvent } from "sap/ui/table/Table";
import Text from "sap/m/Text";
import UIComponent from "sap/ui/core/UIComponent";
import MessageBox from "sap/m/MessageBox";
import DatePicker from "sap/m/DatePicker";
import { ValueState } from "sap/ui/core/library";
import Column from "sap/ui/table/Column";
import SmartFilterBar from "sap/ui/comp/smartfilterbar/SmartFilterBar";
import Title from "sap/m/Title";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";

/**
 * Minimal shape of a RetroBillScreen1 row needed to compute the
 * F2 <-> G2/L2 relational sort order. Row objects read from OData carry
 * more fields than this (see the view's columns), but Record<string,
 * unknown> results from ODataModel#read() only satisfy this if narrowed
 * to a named interface - hence this rather than an inline object type.
 */
interface IRetroSortRow {
    ParentBillingDocument: string;
    BillingDocument: string;
    BillingDocumentItem: string;
    BillingType: string;
    RetroBillingNo: string;
    RetroBillingItemNo: string;
    [key: string]: unknown;
}

/**
 * @namespace retrobillingapp.controller
 */
export default class retrobillingapp extends Controller {

    /** Guards one-time attachment of the F2-highlight "rowsUpdated" handler. */
    private _bF2HighlightAttached: boolean = false;

    /** Guards one-time attachment of the row-selection guard/visual-disable logic. */
    private _bSelectionGuardAttached: boolean = false;

    /** Inline background color applied to F2 rows (sky blue). */
    private static readonly F2_ROW_COLOR = "#c0c7c0e9";

    /**
     * Inline background color applied to CBRE rows - a different parent
     * document type (see _isParentType), visually distinguished from F2
     * so the user can tell the two apart at a glance while both are shown
     * as parents in the same table.
     */
    private static readonly CBRE_ROW_COLOR = "#b7a4c1";

    /**
     * The SmartTable's inner sap.ui.table.Table, captured once in
     * onSmartTableInitialise so onPostCrDr can read the current selection
     * without having to re-derive it from a fresh event.
     */
    private _oInnerTable: Table | undefined;

    /**
     * The filters currently applied to the table's binding (date range,
     * SmartFilterBar filters, etc.), captured in onBeforeRebindTable so
     * the F2-only count request (_updateF2Count) can reuse the exact
     * same filter set - minus BillingType, which it adds on top.
     */
    private _aCurrentFilters: Filter[] = [];

    public onInit(): void {
        const oFilterModel = new JSONModel({
            fromBillingDate: "",
            toBillingDate: "",
            pricingType: "C",
            salesOrderCrDrDate: "",
            splitMaterialWise: false,
            splitPurchaseOrderWise: false,
            onlyRetroBillingValue: true
        });

        const oView = this.getView();
        if (oView) {
            oView.setModel(oFilterModel, "filterModel");
        }

        // Needed so returning here after dismissing screen 2's post-result
        // dialog can reset this screen (see _onRouteMatched) - the router
        // caches this view/controller instance, so simply navigating back
        // does NOT naturally re-run any setup code; only an explicit
        // pattern-matched handler fires every time this route is hit.
        const oRouter = (this.getOwnerComponent() as UIComponent).getRouter();
        const oRoute = oRouter.getRoute("Routeretrobillingapp");
        if (oRoute) {
            oRoute.attachPatternMatched(this._onRouteMatched, this);
        }
    }

    /**
     * Fired every time Routeretrobillingapp is matched - including plain
     * "back" navigation from screen 2, not just the initial load. Checks
     * the "/resetScreen1" flag that PostCrDr.controller.ts sets (on the
     * shared "selectedInvoices" component model) right before navigating
     * back here after the user dismisses the post-result dialog - success
     * or failure alike - and if set, wipes this screen back to its
     * just-opened state:
     *   - the custom Billing Date From/To fields (outside the
     *     SmartFilterBar's own field engine - see onPostCrDr) go back to
     *     blank, same as onInit's defaults
     *   - the SmartFilterBar's own fields (Payer, Ship-To, Sales
     *     Organization, Plant, Material Code) go back to blank via
     *     SmartFilterBar#setFilterData({}, true)
     *   - the table itself goes back to empty rather than continuing to
     *     show whatever was last loaded/posted
     * A plain "back" navigation with no post just done (flag not set) is
     * a no-op here - the user's filters/table/selection are left exactly
     * as they were, same as before this change.
     */
    private _onRouteMatched(): void {
        const oComponent = this.getOwnerComponent() as UIComponent;
        const oSelectedModel = oComponent.getModel("selectedInvoices") as JSONModel | undefined;
        if (!oSelectedModel?.getProperty("/resetScreen1")) {
            return;
        }
        oSelectedModel.setProperty("/resetScreen1", false);

        const oFilterModel = this.getView()?.getModel("filterModel") as JSONModel | undefined;
        oFilterModel?.setData({
            fromBillingDate: "",
            toBillingDate: "",
            pricingType: "C",
            salesOrderCrDrDate: "",
            splitMaterialWise: false,
            splitPurchaseOrderWise: false,
            onlyRetroBillingValue: true
        });

        const oSmartFilterBar = this.byId("smartFilterBar") as SmartFilterBar | undefined;
        // NOTE: SmartFilterBar does NOT have a public clear() method -
        // "clear" is only an EVENT name (fired when the user presses the
        // filter dialog's own Clear button), not something callable here.
        // setFilterData({}, true) is the actual public API for
        // programmatically wiping every field back to blank - the second
        // argument (bReplace=true) means "replace the whole filter data
        // model with this", not merge, so leftover values from
        // previously-set fields don't linger.
        oSmartFilterBar?.setFilterData({}, true);

        const oInnerTable = this._oInnerTable;
        if (oInnerTable) {
            oInnerTable.setModel(new JSONModel({ rows: [] }));
            oInnerTable.bindRows({ path: "/rows" });
        }

        const oTitle = this.byId("tableTitle") as Title | undefined;
        oTitle?.setText("(0)");

        this._aCurrentFilters = [];
    }

    /**
     * Fired by the "Post CR/DR" toolbar button.
     *
     * Screen 1 no longer looks up New Rate / Rate Difference / Retro
     * Billing Amount for every loaded row - that's expensive and mostly
     * wasted work, since the user only ever acts on a handful of selected
     * parent (F2 or CBRE) lines. Instead, this collects the currently
     * *selected* rows (the G2/L2 selection guard means these are
     * guaranteed to be a parent type already - see _isParentType), hands
     * them to screen 2 via a shared component model, and only THEN
     * navigates. PostCrDr.controller.ts does the pricing lookups, once,
     * for just those rows.
     *
     * The router still caches each route's view instance, so coming back
     * here afterwards leaves this page's filters, table data, sort order,
     * scroll position, and selection completely untouched.
     */
    public onPostCrDr(): void {
        const oFilterModel = this.getView()?.getModel("filterModel") as JSONModel | undefined;
        const bSplitMaterialWise = !!oFilterModel?.getProperty("/splitMaterialWise");
        const bSplitPurchaseOrderWise = !!oFilterModel?.getProperty("/splitPurchaseOrderWise");

        if (!this._validateSplitCheckboxes(bSplitMaterialWise, bSplitPurchaseOrderWise)) {
            return;
        }

        // Sales Organization for the Sales Order header must come from
        // this screen's own SELECTED FILTER PARAMETER, not from any single
        // row's data - it's the value the user typed/picked into the
        // SmartFilterBar's mandatory "Sales Organization" field, read here
        // directly off the filter bar rather than off the table rows.
        const oSmartFilterBar = this.byId("smartFilterBar") as SmartFilterBar | undefined;
        const oFilterData = oSmartFilterBar?.getFilterData() as Record<string, unknown> | undefined;
        // SmartFilterBar's getFilterData() shape depends on the field's
        // value-help configuration, not just whether it's single/multi:
        //   - plain/free-text fields: a bare string
        //   - basic single-value fields: { value: "4000", ... }
        //   - value-help-backed fields (e.g. SalesOrganization here, which
        //     needs a valid VKORG picked from a value list): the actual
        //     selection lives in items[0].key, and .value stays "" even
        //     though the field visibly shows a selected value. Reading
        //     only .value silently produced "" here (confirmed via
        //     console logging on screen 2 - the row data itself carried
        //     the correct SalesOrganization, but the value forwarded from
        //     this filter was blank), which S/4 then rejected with
        //     "The sales area could not be determined" on Post, since an
        //     empty SalesOrganization can never resolve a sales area.
        const vSalesOrgFilterValue = oFilterData?.SalesOrganization as
            { value?: string; items?: Array<{ key?: string }> } | string | undefined;
        const sSalesOrganization =
            (typeof vSalesOrgFilterValue === "string"
                ? vSalesOrgFilterValue
                : vSalesOrgFilterValue?.value || vSalesOrgFilterValue?.items?.[0]?.key) || "";

        const oInnerTable = this._oInnerTable;
        if (!oInnerTable) {
            return;
        }

        const aSelectedIndices = oInnerTable.getSelectedIndices();
        if (!aSelectedIndices || aSelectedIndices.length === 0) {
            MessageBox.warning("Please select at least one F2/CBRE invoice line before posting.");
            return;
        }

        const oBinding = oInnerTable.getBinding("rows") as unknown as {
            getLength: () => number;
            getContexts: (iStart: number, iLength: number) => Array<{ getObject: () => Record<string, unknown> } | null>;
        } | undefined;

        if (!oBinding) {
            return;
        }

        const aContexts = oBinding.getContexts(0, oBinding.getLength());

        const aSelectedRows = aSelectedIndices
            .map((iIndex) => aContexts[iIndex])
            .filter((oCtx): oCtx is { getObject: () => Record<string, unknown> } => !!oCtx)
            .map((oCtx) => oCtx.getObject())
            // Belt-and-braces: the selection guard already prevents G2/L2
            // from being selected in the first place (see
            // _isSelectionSuppressed), but screen 2 only ever wants to
            // work with parent (F2/CBRE) lines regardless of how a row
            // ended up in this list.
            .filter((oRow) => this._isParentType(oRow.BillingType as string));

        if (aSelectedRows.length === 0) {
            MessageBox.warning("Please select at least one F2/CBRE invoice line before posting.");
            return;
        }

        const oComponent = this.getOwnerComponent() as UIComponent;
        oComponent.setModel(
            new JSONModel({
                rows: aSelectedRows,
                splitMaterialWise: bSplitMaterialWise,
                splitPurchaseOrderWise: bSplitPurchaseOrderWise,
                // Screen 1's selected Sales Organization filter parameter -
                // used as the Sales Order header's Sales Organization for
                // every group, per the Post API mapping.
                salesOrganization: sSalesOrganization
            }),
            "selectedInvoices"
        );

        oComponent.getRouter().navTo("RoutePostCrDr");
    }

    /**
     * "Split Material Wise" and "Split Purchase Order Wise" are both
     * acceptable individually, and it's fine to check both - but the user
     * must pick at least one before posting. Called at the top of
     * onPostCrDr, right before it collects the F2 selection and navigates
     * to screen 2, so an invalid state never leaves this page.
     */
    private _validateSplitCheckboxes(bSplitMaterialWise: boolean, bSplitPurchaseOrderWise: boolean): boolean {
        if (!bSplitMaterialWise && !bSplitPurchaseOrderWise) {
            MessageBox.warning(
                "Please select at least one of 'Split Material Wise' or 'Split Purchase Order Wise' before posting."
            );
            return false;
        }

        return true;
    }

    /**
     * Fired on "change" of either custom Billing Date From/To DatePicker
     * (wired in BillingDateRangeFilters.fragment.xml). These two fields
     * live outside the entity-driven part of the SmartFilterBar (they're
     * plain controls bound to the local "filterModel"), so the
     * SmartFilterBar's own mandatory-field engine never re-checks them
     * once a value is typed - re-validating them here on every change is
     * what actually clears the stale "required" state and enforces
     * From <= To.
     */
    public onBillingDateChange(): void {
        this._validateBillingDateRange();
    }

    /**
     * Fired when the user presses "Go" on the SmartFilterBar. Gives
     * immediate feedback (value state + message box) if the custom date
     * fields are invalid. The actual, guaranteed block on fetching data
     * happens in onBeforeRebindTable (see below), since that's the hook
     * SmartTable itself respects for cancelling a rebind - this handler
     * exists purely so the user sees the message right when they click
     * Go, without waiting on SmartTable's own binding attempt.
     */
    public onFilterBarSearch(): void {
        if (!this._validateBillingDateRange()) {
            MessageBox.error(
                "Please correct the highlighted Billing Date filters before continuing."
            );
        }
    }

    /**
     * Validates the two custom Billing Date From/To DatePickers:
     *   - both are required
     *   - From must not be later than To
     * Sets valueState/valueStateText directly on the controls so the
     * error is visible right at the field, and returns whether the
     * current values are valid overall. Single source of truth, called
     * from the change handler (live feedback), the search handler
     * (Go button feedback), and onBeforeRebindTable (the actual gate).
     */
    private _validateBillingDateRange(): boolean {
        const oFromControl = this.byId("customFromBillingDate") as DatePicker | undefined;
        const oToControl = this.byId("customToBillingDate") as DatePicker | undefined;

        if (!oFromControl || !oToControl) {
            return true;
        }

        const sFrom = oFromControl.getValue();
        const sTo = oToControl.getValue();

        oFromControl.setValueState(ValueState.None);
        oFromControl.setValueStateText("");
        oToControl.setValueState(ValueState.None);
        oToControl.setValueStateText("");

        let bValid = true;

        if (!sFrom) {
            oFromControl.setValueState(ValueState.Error);
            oFromControl.setValueStateText("Billing Date From is a required field.");
            bValid = false;
        }

        if (!sTo) {
            oToControl.setValueState(ValueState.Error);
            oToControl.setValueStateText("Billing Date To is a required field.");
            bValid = false;
        }

        if (sFrom && sTo) {
            const oFromDate = oFromControl.getDateValue();
            const oToDate = oToControl.getDateValue();

            if (oFromDate && oToDate && oFromDate.getTime() > oToDate.getTime()) {
                oFromControl.setValueState(ValueState.Error);
                oFromControl.setValueStateText("Billing Date From must not be later than Billing Date To.");
                oToControl.setValueState(ValueState.Error);
                oToControl.setValueStateText("Billing Date To must not be earlier than Billing Date From.");
                bValid = false;
            }
        }

        return bValid;
    }

    /**
     * Fired once by the SmartTable, after it has built its own
     * metadata-driven columns from RetroBillScreen1.
     *
     * New Rate / Rate Difference / Retro Billing Amount are NOT injected
     * here anymore (that logic now lives in PostCrDr.controller.ts via
     * model/PricingService.ts, run only for the rows the user selects).
     * This now only wires up the F2 row highlight, the G2/L2
     * selection guard, and the BillingDate display format.
     */
    public onSmartTableInitialise(oEvent: Event<Record<string, object>>): void {
        const oSmartTable = oEvent.getSource() as unknown as { getTable: () => Table };
        const oInnerTable = oSmartTable.getTable();
        const oView = this.getView();

        if (!oInnerTable || !oView) {
            return;
        }

        this._oInnerTable = oInnerTable;

        // Attach once: recolors F2 rows whenever the table (re)renders its
        // visible rows (initial load, scroll, sort, paging, rebind).
        if (!this._bF2HighlightAttached) {
            oInnerTable.attachEvent("rowsUpdated", this._applyF2RowHighlight.bind(this, oInnerTable));
            this._bF2HighlightAttached = true;
        }

        // Attach once: (a) blocks selection of G2/L2 rows the instant the
        // user tries to check them, and (b) paints their row-selector
        // checkbox as visually disabled whenever the table (re)renders its
        // visible rows. Same "rowsUpdated"-driven approach as the F2
        // highlight above, since sap.ui.table.Table has no public API to
        // disable an individual row's selection checkbox.
        if (!this._bSelectionGuardAttached) {
            oInnerTable.attachRowSelectionChange(this._onRowSelectionChange.bind(this, oInnerTable));
            oInnerTable.attachEvent("rowsUpdated", this._applyDisabledCheckboxStyling.bind(this, oInnerTable));
            this._bSelectionGuardAttached = true;
        }

        // Ensure BillingDate column displays in dd.MM.yyyy format
        const aColumns = oInnerTable.getColumns();
        const iBillingDateIndex = this._findColumnIndexByField(aColumns, "BillingDate");
        if (iBillingDateIndex >= 0) {
            try {
                const oBillingCol = aColumns[iBillingDateIndex];
                oBillingCol.setTemplate(new Text({ text: { path: "BillingDate", formatter: this._formatDateDisplay.bind(this) } }));
            } catch (e) {
                // ignore
            }
        }
    }

    private _formatDateDisplay(vDate: unknown): string {
        if (!vDate) {
            return "";
        }
        let oDate: Date | null = null;
        if (vDate instanceof Date) {
            oDate = vDate;
        } else if (typeof vDate === "string") {
            oDate = new Date(vDate);
        }
        if (!oDate || isNaN(oDate.getTime())) {
            return "";
        }
        const dd = String(oDate.getDate()).padStart(2, "0");
        const mm = String(oDate.getMonth() + 1).padStart(2, "0");
        const yyyy = oDate.getFullYear();
        return `${dd}.${mm}.${yyyy}`;
    }

    /**
     * Called whenever sap.ui.table.Table fires "rowsUpdated" (initial
     * render, scroll, sort, paging, rebind). Walks the currently rendered
     * Row instances, checks each one's BillingType, and paints F2 rows
     * sky blue and CBRE rows a distinct light blue by setting inline
     * styles directly on the DOM. F2 and CBRE are both "parent" document
     * types (see _isParentType) - shown and counted alongside each other,
     * each with their own children (G2/L2) rows - so they're each given
     * their own color rather than sharing F2's.
     *
     * Two things make this different (and more reliable) than a plain
     * CSS class toggle:
     *   1. sap.ui.table.Table renders each cell's content inside a nested
     *      <div class="sapUiTableCellInner">, which carries its own
     *      theme background and visually sits ON TOP of the <tr>/<td>.
     *      Coloring only the <tr> is invisible - the inner div has to be
     *      colored too.
     *   2. Inline styles (set here) beat any CSS specificity fight with
     *      the theme's own stylesheet, so this doesn't depend on
     *      css/style.css being deployed/loaded at all.
     * Rows are matched via the "data-sap-ui-rowindex" attribute (the
     * row's position within the visible viewport, 0-based).
     */
    private _applyF2RowHighlight(oInnerTable: Table): void {
        const aRows = oInnerTable.getRows ? oInnerTable.getRows() : [];
        const oTableDomRef = oInnerTable.getDomRef();
        if (!oTableDomRef) {
            return;
        }

        aRows.forEach((oRow, iVisualIndex) => {
            const oCtx = oRow.getBindingContext();
            const oData = oCtx && (oCtx.getObject() as Record<string, string> | undefined);
            const sColor =
                oData && oData.BillingType === "F2" ? retrobillingapp.F2_ROW_COLOR :
                oData && oData.BillingType === "CBRE" ? retrobillingapp.CBRE_ROW_COLOR :
                undefined;

            // Matches the <tr> in both the fixed-columns table (if any)
            // and the scrollable table, since both share this attribute.
            const aTrs = oTableDomRef.querySelectorAll<HTMLTableRowElement>(
                `tr[data-sap-ui-rowindex="${iVisualIndex}"]`
            );

            aTrs.forEach((oTr) => {
                const aCells = oTr.querySelectorAll<HTMLElement>("td");
                aCells.forEach((oCell) => {
                    this._setCellHighlight(oCell, sColor);
                    const oInner = oCell.querySelector<HTMLElement>(".sapUiTableCellInner");
                    if (oInner) {
                        this._setCellHighlight(oInner, sColor);
                    }
                });
            });
        });
    }

    private _setCellHighlight(oEl: HTMLElement, sColor: string | undefined): void {
        if (sColor) {
            oEl.style.setProperty("background-color", sColor, "important");
        } else {
            oEl.style.removeProperty("background-color");
        }
    }

    /**
     * Fired on sap.ui.table.Table's "rowSelectionChange". G2 and L2 rows
     * must never end up selected - if the user manages to click their
     * (visually disabled) checkbox anyway, or selects them via keyboard/
     * select-all, this immediately reverts just that row's selection.
     * This is the functional guarantee; _applyDisabledCheckboxStyling
     * below is only the visual cue and is not itself sufficient to block
     * selection, since sap.ui.table.Table exposes no per-row "selectable"
     * flag to disable the checkbox at the control level.
     */
    private _onRowSelectionChange(oInnerTable: Table, oEvent: Table$RowSelectionChangeEvent): void {
        const iRowIndex = oEvent.getParameter("rowIndex");
        if (iRowIndex === undefined || iRowIndex < 0) {
            return;
        }

        const oRow = oInnerTable.getRows().find((r) => r.getIndex() === iRowIndex);
        const oCtx = oRow && oRow.getBindingContext();
        const oData = oCtx && (oCtx.getObject() as Record<string, string> | undefined);

        if (oData && this._isSelectionSuppressed(oData.BillingType)) {
            oInnerTable.removeSelectionInterval(iRowIndex, iRowIndex);
        }
    }

    /**
     * Called whenever sap.ui.table.Table fires "rowsUpdated" (initial
     * render, scroll, sort, paging, rebind). Walks the currently rendered
     * Row instances and, for G2/L2 rows, greys out and disables pointer
     * events on the row's selection-checkbox cell so it looks inactive/
     * unclickable - mirroring how _applyF2RowHighlight paints F2 rows.
     * Matched the same way, via the "data-sap-ui-rowindex" attribute.
     */
    private _applyDisabledCheckboxStyling(oInnerTable: Table): void {
        const aRows = oInnerTable.getRows ? oInnerTable.getRows() : [];
        const oTableDomRef = oInnerTable.getDomRef();
        if (!oTableDomRef) {
            return;
        }

        aRows.forEach((oRow, iVisualIndex) => {
            const oCtx = oRow.getBindingContext();
            const oData = oCtx && (oCtx.getObject() as Record<string, string> | undefined);
            const bDisable = !!oData && this._isSelectionSuppressed(oData.BillingType);

            const aTrs = oTableDomRef.querySelectorAll<HTMLTableRowElement>(
                `tr[data-sap-ui-rowindex="${iVisualIndex}"]`
            );

            aTrs.forEach((oTr) => {
                // The row-selector cell is the first cell in the fixed
                // (row-header) part of the row; sap.ui.table marks it with
                // this class across current UI5 versions. Fall back to the
                // first <td> if the class isn't present, so this keeps
                // working even if the theme/version renders it slightly
                // differently.
                const oSelectionCell =
                    oTr.querySelector<HTMLElement>(".sapUiTableRowSelectionCell") ||
                    oTr.querySelector<HTMLElement>("td");

                if (!oSelectionCell) {
                    return;
                }

                const oCheckboxInput = oSelectionCell.querySelector<HTMLInputElement>("input[type='checkbox']");

                if (bDisable) {
                    oSelectionCell.style.setProperty("opacity", "0.4", "important");
                    oSelectionCell.style.setProperty("pointer-events", "none", "important");
                    oSelectionCell.style.setProperty("cursor", "not-allowed", "important");
                    if (oCheckboxInput) {
                        oCheckboxInput.disabled = true;
                    }
                } else {
                    oSelectionCell.style.removeProperty("opacity");
                    oSelectionCell.style.removeProperty("pointer-events");
                    oSelectionCell.style.removeProperty("cursor");
                    if (oCheckboxInput) {
                        oCheckboxInput.disabled = false;
                    }
                }
            });
        });
    }

    /**
     * G2 (credit) and L2 (debit) records can't be posted for CR/DR on
     * their own - only an original parent invoice/document line (F2 or
     * CBRE - see _isParentType) can be selected and carried forward to
     * the Post CR/DR screen. CBRE is now selectable exactly like F2 (both
     * are parent types - see _isParentType and onPostCrDr's parent-type
     * filter), so only G2/L2 remain suppressed here. Used both to block
     * selection of these rows and to grey out their checkbox.
     */
    private _isSelectionSuppressed(sBillingType: string): boolean {
        return sBillingType === "G2" || sBillingType === "L2";
    }

    /**
     * A "parent" document type: the original invoice/document a G2/L2
     * credit/debit line refers back to. F2 is the original parent type;
     * CBRE is a second parent type shown and counted alongside F2 (see
     * _applyF2RowHighlight, _updateF2Count), each with its own distinct
     * highlight color and its own set of G2/L2 children. Not currently
     * used by the sort/group logic below by name - kept as the single
     * source of truth for "is this a parent row" wherever that check is
     * needed going forward.
     */
    private _isParentType(sBillingType: string): boolean {
        return sBillingType === "F2" || sBillingType === "CBRE";
    }

    /**
     * SmartTable stamps each generated sap.ui.table.Column with custom
     * data ("p13nData") containing the underlying entity field's
     * technical name (columnKey). We read that to find columns reliably,
     * regardless of label/i18n text or column order.
     */
    /**
     * Because onBeforeRebindTable sets preventTableBind=true (needed for
     * the custom F2/G2/L2 relational sort - see there for why), SmartTable
     * never fires its own "dataReceived" and so never clears the busy
     * indicator - nor the separate "stale data" overlay (see below) - it
     * switches on for every rebind trigger, including ad-hoc fields added
     * via the "Filters" (P13n) button - not just the fields declared
     * directly in the SmartFilterBar. Left unmanaged, this leaves the
     * whole table greyed out and unresponsive until a full page refresh.
     * This helper is the single point that takes over that responsibility:
     * called with true right as the custom fetch starts, and false in
     * both the success and error paths of _bindTableWithRetroSort.
     *
     * IMPORTANT: this deliberately toggles busy on the INNER sap.ui.table.
     * Table (this._oInnerTable), not on the outer SmartTable wrapper.
     * SmartTable keeps its own internal "is loading" bookkeeping tied to
     * the dataRequested/dataReceived pair of the binding it itself creates
     * - since preventTableBind=true means that binding is never created,
     * SmartTable's own bookkeeping never rolls back to "not busy" and just
     * accumulates with every subsequent Go/filter change. Calling
     * setBusy() on the SmartTable wrapper only ever addresses OUR flag,
     * not that stuck internal one, so on the second (and every later)
     * rebind the wrapper still renders its busy overlay - greying out the
     * whole table and disabling the row checkboxes - even right after we
     * call setBusy(false). Setting busy directly on the inner table
     * instead sidesteps SmartTable's internal state machine entirely: it's
     * a plain Control busy flag under our exclusive control, so it always
     * ends up exactly where our true/false calls last left it.
     *
     * SEPARATE ISSUE, SAME ROOT CAUSE: sap.ui.table.Table also has its own
     * "stale data" overlay (showOverlay) - a translucent grey layer with
     * pointer-events disabled (which is exactly why the row checkboxes
     * stop being clickable). SmartTable switches this on itself the
     * instant the SmartFilterBar's filter values change, as a visual cue
     * that the currently-rendered rows no longer match the filters, and
     * normally clears it again once its own rebind's dataReceived fires.
     * Since preventTableBind blocks that internal binding from ever
     * completing, this overlay - like busy - gets switched on with every
     * filter change and never switched back off on its own. It is
     * completely independent of the busy flag (both can be true/false in
     * any combination), so clearing busy alone is not enough; we clear
     * both here whenever bBusy is false.
     */
    private _setSmartTableBusy(bBusy: boolean): void {
        const oInnerTable = this._oInnerTable as unknown as
            { setBusy: (b: boolean) => void; setShowOverlay: (b: boolean) => void } | undefined;
        if (oInnerTable) {
            oInnerTable.setBusy(bBusy);
            if (!bBusy) {
                oInnerTable.setShowOverlay(false);
            }
            return;
        }
        // Inner table not captured yet (e.g. the very first auto-triggered
        // rebind can race onSmartTableInitialise) - fall back to the
        // wrapper so the very first load still shows a busy state.
        const oSmartTable = this.byId("smartTable") as unknown as { setBusy: (b: boolean) => void } | undefined;
        oSmartTable?.setBusy(bBusy);
    }

    private _findColumnIndexByField(aColumns: Column[], sFieldName: string): number {
        for (let i = 0; i < aColumns.length; i++) {
            const vP13n = aColumns[i].data("p13nData");
            if (!vP13n) {
                continue;
            }
            try {
                const oP13n = typeof vP13n === "string" ? JSON.parse(vP13n) : vP13n;
                if (oP13n && (oP13n.columnKey === sFieldName || oP13n.leadingProperty === sFieldName)) {
                    return i;
                }
            } catch (e) {
                // ignore malformed p13nData on a given column and keep scanning
            }
        }
        return -1;
    }

    /**
     * Fired by the SmartTable before it (re)binds its rows.
     * - Applies the custom "From Billing Date" / "To Billing Date" range
     *   filters (BillingDate >= from, BillingDate <= to) on top of whatever
     *   filters the SmartFilterBar itself already contributed.
     * - Prevents SmartTable's own automatic bind (preventTableBind) and
     *   instead fetches + sorts the rows itself (_bindTableWithRetroSort),
     *   so each F2 (original invoice) line is immediately followed by the
     *   G2/L2 line(s) that reference it, within each Parent Billing
     *   Document group - see _sortRetroRows.
     */
    public onBeforeRebindTable(oEvent: Event<Record<string, object>>): void {
        const oBindingParams = oEvent.getParameter("bindingParams") as {
            sorter: Sorter[];
            filters: Filter[];
            preventTableBind?: boolean;
        };

        const bDatesValid = this._validateBillingDateRange();

        if (!bDatesValid) {
            oBindingParams.filters = [
                new Filter("BillingDate", FilterOperator.EQ, "1900-01-01T00:00:00")
            ];
            MessageBox.error(
                "Please correct the highlighted Billing Date filters before continuing."
            );
            this._setSmartTableBusy(false);
            return;
        }

        const oView = this.getView();
        const oFilterModel = oView && (oView.getModel("filterModel") as JSONModel | undefined);
        if (oFilterModel) {
            const sFromDate = oFilterModel.getProperty("/fromBillingDate") as string;
            const sToDate = oFilterModel.getProperty("/toBillingDate") as string;
            const aDateFilters: Filter[] = [];

            if (sFromDate) {
                aDateFilters.push(new Filter("BillingDate", FilterOperator.GE, sFromDate));
            }
            if (sToDate) {
                aDateFilters.push(new Filter("BillingDate", FilterOperator.LE, sToDate));
            }

            if (aDateFilters.length > 0) {
                oBindingParams.filters = oBindingParams.filters || [];
                oBindingParams.filters.push(new Filter({ filters: aDateFilters, and: true }));
            }
        }

        // Relational "F2 line, then its own matching G2/L2 line(s)" order
        // can't be expressed via $orderby/sap.ui.model.Sorter at all - a
        // Sorter's comparator only ever compares two values of the SAME
        // field for two rows (e.g. BillingType vs BillingType); it has no
        // way to match one row's RetroBillingNo/RetroBillingItemNo against
        // another row's BillingDocument/BillingDocumentItem. So instead of
        // letting SmartTable bind the OData path directly, take over
        // binding entirely: fetch the full filtered result set ourselves,
        // sort it in JS (_sortRetroRows), and bind the inner table to a
        // plain JSONModel holding that sorted array. See
        // _bindTableWithRetroSort for the rest.
        oBindingParams.preventTableBind = true;

        // Because preventTableBind=true stops SmartTable from ever binding
        // (and therefore ever firing its own "dataReceived"), SmartTable's
        // busy indicator - switched on the moment "Go"/a filter change
        // triggers this rebind - would otherwise never switch back off,
        // leaving the table permanently greyed out and unresponsive until
        // a full page refresh. Since we're taking over the fetch
        // ourselves, we also take over clearing that busy state: see the
        // setBusy(false) calls in _bindTableWithRetroSort's success/error
        // callbacks below.
        this._setSmartTableBusy(true);

        // Remember exactly what's being sent to the table's own binding
        // (date range + whatever the SmartFilterBar contributed), so
        // _updateF2Count can ask for a count against the identical filter
        // set, just narrowed down to BillingType = F2.
        this._aCurrentFilters = oBindingParams.filters ? [...oBindingParams.filters] : [];
        this._updateF2Count();
        this._bindTableWithRetroSort(this._aCurrentFilters);
    }

    /**
     * Fetches the full RetroBillScreen1 result set for the given filters
     * (no $skip/$top paging - the relational sort below needs to see
     * every row for the current filters at once) and hands the sorted
     * result to the inner table via a local JSONModel.
     *
     * Column cell bindings in the view (e.g. "{BillingDocument}") are
     * unnamed, so setting an unnamed model directly on the inner table
     * makes them resolve against this JSONModel instead of the inherited
     * OData model - no view.xml changes needed. Row-level code elsewhere
     * in this controller (F2 highlight, selection guard, onPostCrDr) only
     * ever calls generic ListBinding methods (getContexts/getObject), so
     * it works the same regardless of which model backs "rows".
     */
    private _bindTableWithRetroSort(aFilters: Filter[]): void {
        const oInnerTable = this._oInnerTable;
        const oView = this.getView();
        if (!oInnerTable || !oView) {
            return;
        }

        const oModel = oView.getModel() as ODataModel | undefined;
        if (!oModel) {
            return;
        }

        oModel.read("/RetroBillScreen1", {
            filters: aFilters,
            urlParameters: {
                // High enough to always cover a full filtered result set;
                // paging is handled client-side by the grid table's own
                // virtual scrolling once bound to the JSONModel.
                "$top": "5000"
            },
            success: (oData: { results?: IRetroSortRow[] }) => {
                const aSorted = this._sortRetroRows(oData.results || []);
                const oJSONModel = new JSONModel({ rows: aSorted });
                oInnerTable.setModel(oJSONModel);
                oInnerTable.bindRows({ path: "/rows" });
                this._setSmartTableBusy(false);
            },
            error: (oError: unknown) => {
                // eslint-disable-next-line no-console
                console.error("[RetroSort] Failed to load table rows:", oError);
                MessageBox.error("Could not load Retro Billing Items. Please try again.");
                this._setSmartTableBusy(false);
            }
        });
    }

    /**
     * Groups rows by Parent Billing Document, and within each group
     * places each F2 (original invoice) line immediately followed by the
     * G2/L2 line(s) that reference it - not every F2 line in the group
     * first, then every G2/L2 line.
     *
     * A G2/L2 row references its originating F2 row via
     * RetroBillingNo/RetroBillingItemNo, which line up with that F2 row's
     * own BillingDocument/BillingDocumentItem, e.g.:
     *
     *   F2  BillingDocument=90000203 BillingDocumentItem=10
     *   L2  RetroBillingNo=0090000203 RetroBillingItemNo=10   <- belongs right after that F2
     *
     * Rather than a cross-row matching pass, every row is given a "group
     * key":
     *   - F2 row    -> its own BillingDocument + BillingDocumentItem
     *   - G2/L2 row -> its RetroBillingNo + RetroBillingItemNo
     * An F2 row and the G2/L2 row(s) that reference it always end up with
     * an identical group key, so sorting by
     * (ParentBillingDocument, group key, type rank F2 < G2 < L2) puts each
     * G2/L2 line directly under its own F2 line.
     */
    private _sortRetroRows<T extends IRetroSortRow>(aRows: T[]): T[] {
        const fnNormKey = (sDoc: string, sItem: string): string => {
            const iDoc = parseInt(sDoc, 10) || 0;
            const iItem = parseInt(sItem, 10) || 0;
            return `${String(iDoc).padStart(10, "0")}-${String(iItem).padStart(6, "0")}`;
        };

        const fnGroupKey = (oRow: T): string =>
            this._isParentType(oRow.BillingType)
                ? fnNormKey(oRow.BillingDocument, oRow.BillingDocumentItem)
                : fnNormKey(oRow.RetroBillingNo, oRow.RetroBillingItemNo);

        const fnTypeRank = (sBillingType: string): number =>
            this._isParentType(sBillingType) ? 0 : sBillingType === "G2" ? 1 : sBillingType === "L2" ? 2 : 3;

        return [...aRows].sort((a, b) => {
            if (a.ParentBillingDocument !== b.ParentBillingDocument) {
                return a.ParentBillingDocument < b.ParentBillingDocument ? -1 : 1;
            }
            const sGroupKeyA = fnGroupKey(a);
            const sGroupKeyB = fnGroupKey(b);
            if (sGroupKeyA !== sGroupKeyB) {
                return sGroupKeyA < sGroupKeyB ? -1 : 1;
            }
            return fnTypeRank(a.BillingType) - fnTypeRank(b.BillingType);
        });
    }

    /**
     * showRowCount on the SmartTable would display the total number of
     * rows returned - parent (F2/CBRE) rows plus their G2/L2 children
     * combined - since G2/L2 are the credit/debit counterparts pulled in
     * alongside each parent line. The user only cares about how many
     * parent (original invoice/document) lines are on screen, so that's
     * counted independently here via a dedicated $inlinecount/$top=0
     * request (same filters as the table, plus BillingType eq 'F2' or
     * BillingType eq 'CBRE'), and the result is written into the
     * toolbar's "tableTitle" Title control instead of relying on
     * SmartTable's count.
     */
    private _updateF2Count(): void {
        const oInnerTable = this._oInnerTable;
        const oTitle = this.byId("tableTitle") as Title | undefined;

        if (!oInnerTable || !oTitle) {
            return;
        }

        const oModel = this.getView()?.getModel() as ODataModel | undefined;
        if (!oModel) {
            return;
        }

        const aFilters = [
            ...this._aCurrentFilters,
            new Filter({
                filters: [
                    new Filter("BillingType", FilterOperator.EQ, "F2"),
                    new Filter("BillingType", FilterOperator.EQ, "CBRE")
                ],
                and: false
            })
        ];

        oModel.read("/RetroBillScreen1", {
            filters: aFilters,
            urlParameters: {
                "$top": "0",
                "$inlinecount": "allpages"
            },
            success: (oData: { __count?: string }) => {
                const sCount = oData && oData.__count ? oData.__count : "0";
                oTitle.setText(`(${sCount})`);
            },
            error: () => {
                // Leave whatever count was last shown rather than blanking
                // the title out on a transient request failure.
            }
        });
    }
}