import Controller from "sap/ui/core/mvc/Controller";
import UIComponent from "sap/ui/core/UIComponent";
import JSONModel from "sap/ui/model/json/JSONModel";
import DatePicker from "sap/m/DatePicker";
import MessageToast from "sap/m/MessageToast";
import MessageBox from "sap/m/MessageBox";
import Event from "sap/ui/base/Event";
import Table from "sap/ui/table/Table";
import ODataModel from "sap/ui/model/odata/v2/ODataModel";
import Spreadsheet from "sap/ui/export/Spreadsheet";
import { EdmType } from "sap/ui/export/library";
import {
    IConditionRateParams,
    RATE_LOADING,
    RATE_NOT_FOUND,
    CONDITION_TYPE_RATE,
    CONDITION_TYPE_DISCOUNT,
    buildKey,
    fetchConditionRate,
    computeRateDifference,
    computeRetroBillingAmountFromNewAmount,
    computeNewDiscountAmount,
    computeNewAmount,
    negateAmount,
    applyDiscountToRetroBillingAmount,
    computeFinalRetroBillingAmount
} from "../model/PricingService";

/** Shape of a single row on this screen's table. */
interface IPostCrDrRow {
    /**
     * Carried through unchanged from screen 1's row (F2 or CBRE - see
     * retrobillingapp.controller.ts's _isParentType). Only ever used here
     * to decide the sign of NewAmount in _applyRateToMatchingRows - CBRE
     * parents post the negative of the normal F2 calculation.
     */
    BillingType: string;
    ParentBillingDocument: string;
    /** Item number within ParentBillingDocument - carried through from screen 1 the same way. */
    BillingDocumentItem: string;
    /** ODN (Outlet Delivery Note) Number - carried through from screen 1, displayed beside Billing Document Item. */
    ODNNumber: string;
    SalesOrganization: string;
    /** Taken from our own OData service per F2 invoice - needed for the Sales Order header. */
    DistributionChannel: string;
    /** Taken from our own OData service per F2 invoice - needed for the Sales Order header. */
    Division: string;
    /** Optional organization division field when the service returns it for the invoice row. */
    OrganizationDivision?: string;
    BillToPartyCode: string;
    BillToPartyName: string;
    ShipToPartyCode: string;
    ShipToPartyName: string;
    CustomerPONumber: string;
    MaterialCode: string;
    MaterialDescription: string;
    CustomerMaterialCode: string;
    Plant: string;
    BillingQuantity: string;
    /** Displayed beside New Rate, and also used to compute Rate Difference. */
    OriginalRate: string;
    /** Carried along only to compute Retro Billing Amount - not displayed. */
    ItemNetValueTotal: string;
    /** Carried along only as part of the pricing lookup key - not displayed. */
    BillingDate: string;
    NewRate: string;
    /** New Rate * Billing Quantity. Depends only on NewRate having resolved - unlike NewDiscountAmount/RetroBillingAmount, doesn't wait on New Discount Percent. */
    NewAmount: string;
    RateDifference: string;
    RetroBillingAmount: string;
    /**
     * Retro Billing Amount + (Retro Billing Amount * New Discount Percent / 100).
     * NOT displayed on screen (the table keeps showing RetroBillingAmount as
     * before) - this is the value actually POSTED as the DPR1 condition rate
     * and used to decide CR vs DR when building the memo request payloads.
     */
    FinalRetroBillingAmount: string;
    /** Carried forward unchanged from screen 1's "Discount" field. */
    OriginalDiscountPercent: string;
    /** Fetched the same way as New Rate, but with ConditionType Z007 instead of ZPR0. */
    NewDiscountPercent: string;
    /** New Rate * Billing Quantity * (New Discount Percent / 100). Depends on BOTH NewRate and NewDiscountPercent having resolved. */
    NewDiscountAmount: string;
    /** Human-readable Sales Order group this row will post under (Yes-belonging rows only). */
    SalesOrderGroupLabel: string;
    /** Stable sort/banding key for the group above; MAX_SAFE_INTEGER for rows not in any group. */
    SalesOrderGroupIndex: number;
}

/** Allowed values for the "Show Only Retro Billing Value" dropdown. */
type TRetroBillingFilterKey = "Y" | "N" | "A";

/** Which of the two separate document APIs a given group posts to. */
type TMemoDocType = "CR" | "DR";

/**
 * One Credit Memo Request or Debit Memo Request to be created via OData
 * V2 deep insert: a single POST with the header fields plus nested
 * to_Partner (Ship-To) and to_Item arrays in the same JSON body.
 *
 * CR groups post to API_CREDIT_MEMO_REQUEST_SRV's /A_CreditMemoRequest
 * (header field "CreditMemoRequestType", item field
 * "CreditMemoRequestItem"). DR groups post to
 * API_DEBIT_MEMO_REQUEST_SRV's /A_DebitMemoRequest (header field
 * "DebitMemoRequestType", item field "DebitMemoRequestItem") - these are
 * two entirely separate services/entity sets, not one shared
 * A_SalesOrder like before.
 */
interface IMemoGroupPayload {
    groupLabel: string;
    docType: TMemoDocType;
    payload: {
        SalesOrganization: string;
        DistributionChannel: string;
        OrganizationDivision: string;
        SoldToParty: string;
        SDDocumentReason: string;
        /**
         * The "Sales Order CR/DR Date" the user selects on this screen
         * (mandatory DatePicker "inpSalesOrderCrDrDate") is posted at
         * header level to ALL THREE of these fields, unmodified:
         *   - PricingDate ("Pricing Date" under Sales / Item Overview tab)
         *   - BillingDocumentDate ("Billing Date" under Item Overview tab)
         *   - CreditMemoRequestDate / DebitMemoRequestDate ("Document
         *     Date" under Sales tab) - only one of the two is sent,
         *     matching this group's docType.
         */
        PricingDate: Date;
        BillingDocumentDate: Date;
        CreditMemoRequestDate?: Date;
        DebitMemoRequestDate?: Date;
        CreditMemoRequestType?: string;
        DebitMemoRequestType?: string;
        to_Partner: Array<{
            PartnerFunction: string;
            Customer: string;
        }>;
        to_Item: Array<{
            CreditMemoRequestItem?: string;
            DebitMemoRequestItem?: string;
            Material: string;
            /** Customer's own material code for this row's line item (screen 1's CustomerMaterialCode). */
            MaterialByCustomer: string;
            /** Item-level Customer PO Number (this row's own CustomerPONumber). */
            PurchaseOrderByCustomer: string;
            RequestedQuantity: string;
            /** Custom field - the originating Billing Document (screen 1's ParentBillingDocument) for this item. */
            YY1_BillingRefNo_SDI: string;
            /** Custom field - the originating F2 invoice's own Billing Document Item (screen 1's BillingDocumentItem) for this item. */
            YY1_RetroBillingItemRe_SDI: string;
            // NOTE: BillingDocumentItem is captured on this row (see
            // IPostCrDrRow.BillingDocumentItem) and shown in the UI table,
            // but is NOT posted here yet - "YY1_BillingRefItm_SDI" was a
            // guess and the service rejected it with "Property
            // 'YY1_BillingRefItm_SDI' is invalid". Once you confirm the
            // real custom field name (Custom Fields tab on
            // A_CreditMemoRequestItem / A_DebitMemoRequestItem), add it
            // back here with the correct name.
            /**
             * Deep-inserted pricing condition for this item: ConditionType
             * "DPR1" with ConditionRateValue = this row's Retro Billing
             * Amount.
             *
             * IMPORTANT: post to ConditionRateValue, NOT ConditionAmount.
             * ConditionAmount is a pricing-engine-computed/cumulative
             * result field (base x rate) - it comes back as "0.00" even
             * for system-determined conditions with a real, non-zero
             * rate (e.g. JOCG showing ConditionRateValue "9.000000000"
             * but ConditionAmount "0.00"). ConditionRateValue is the
             * field that actually drives the "Amount" column you see on
             * the Conditions tab in the UI. ConditionCurrency is also
             * set since DPR1 is calculation type "A" (fixed amount, not
             * a %) - without it the rate has no defined unit.
             *
             * NOTE: confirm the exact navigation property name against
             * your service metadata (A_CreditMemoReqItemPrcgElmnt /
             * A_DebitMemoReqItemPrcgElmnt) - "to_PricingElement" is used
             * here to mirror the header-level nav property already seen
             * on A_CreditMemoRequest/A_DebitMemoRequest.
             */
            to_PricingElement: Array<{
                ConditionType: string;
                ConditionRateValue: string;
                ConditionCurrency: string;
            }>;
        }>;
    };
}

/**
 * @namespace retrobillingapp.controller
 */
export default class PostCrDr extends Controller {

    /**
     * Local cache of New Rate per pricing key, scoped to this screen's
     * current set of selected rows. Rebuilt fresh every time the user
     * arrives here from screen 1 (see _onRouteMatched), so a stale rate
     * from a previous selection never leaks into a new one.
     */
    private _mRateCache: Record<string, string> = {};

    /** Same idea as _mRateCache, but for New Discount Percent (ConditionType Z007) lookups. */
    private _mDiscountCache: Record<string, string> = {};

    /** Guards one-time attachment of the group-banding "rowsUpdated" handler. */
    private _bGroupBandingAttached: boolean = false;

    /** Alternating background colors used to visually separate Sales Order groups. */
    private static readonly GROUP_BAND_COLORS = ["#eef2f7", "#ffffff"];

    public onInit(): void {
        const oRouter = (this.getOwnerComponent() as UIComponent).getRouter();
        const oRoute = oRouter.getRoute("RoutePostCrDr");
        if (oRoute) {
            oRoute.attachPatternMatched(this._onRouteMatched, this);
        }

        // Sales Order CR/DR Date must never be backdated - block past dates
        // directly in the calendar popup (today itself remains selectable).
        const oDatePicker = this.byId("inpSalesOrderCrDrDate") as DatePicker;
        if (oDatePicker) {
            const oToday = new Date();
            oToday.setHours(0, 0, 0, 0);
            oDatePicker.setMinDate(oToday);
        }
    }

    /**
     * Fired by the page's back button. Navigates back to the main Retro
     * Billing Items list. The router caches each route's view instance,
     * so the main page's filters, table data, sort order, scroll
     * position, etc. are all exactly as the user left them - nothing on
     * that page gets rebuilt or re-fetched just from navigating here and
     * back.
     */
    public onNavBack(): void {
        const oRouter = (this.getOwnerComponent() as UIComponent).getRouter();
        oRouter.navTo("Routeretrobillingapp");
    }

    /**
     * Fired every time RoutePostCrDr is matched - i.e. every time the
     * user presses "Post CR/DR" on screen 1, since the router reuses this
     * view's instance rather than recreating it. Rebuilds this screen's
     * table from whatever screen 1 most recently placed on the shared
     * "selectedInvoices" component model (set in
     * retrobillingapp.controller.ts#onPostCrDr), then kicks off pricing
     * lookups for just those rows.
     *
     * "/allRows" is the master, always-unfiltered list of everything
     * selected on screen 1. "/rows" is what the table actually binds to,
     * and is re-derived from "/allRows" every time a rate arrives or the
     * "Show Only Retro Billing Value" dropdown changes - so the table
     * always reflects the current dropdown selection immediately, and
     * stays correct as async rates keep loading in.
     */
    private _onRouteMatched(): void {
        this._mRateCache = {};
        this._mDiscountCache = {};

        const oComponent = this.getOwnerComponent() as UIComponent;
        const oSelectedModel = oComponent.getModel("selectedInvoices") as JSONModel | undefined;
        const aSelected = (oSelectedModel?.getProperty("/rows") as Record<string, unknown>[] | undefined) || [];

        // Set on screen 1 (see retrobillingapp.controller.ts#onPostCrDr) and
        // needed here only for the 2nd-priority group split / Sales Order header.
        const bSplitMaterialWise = !!oSelectedModel?.getProperty("/splitMaterialWise");
        const bSplitPurchaseOrderWise = !!oSelectedModel?.getProperty("/splitPurchaseOrderWise");
        const sSalesOrganization = (oSelectedModel?.getProperty("/salesOrganization") as string) || "";

        const aRows: IPostCrDrRow[] = aSelected.map((oRaw) => ({
            BillingType: (oRaw.BillingType as string) || "",
            ParentBillingDocument: (oRaw.ParentBillingDocument as string) || "",
            BillingDocumentItem: (oRaw.BillingDocumentItem as string) || "",
            ODNNumber: (oRaw.ODNNumber as string) || "",
            SalesOrganization: (oRaw.SalesOrganization as string) || "",
            DistributionChannel: (oRaw.DistributionChannel as string) || "",
            Division: (oRaw.Division as string) || "",
            OrganizationDivision: (oRaw.OrganizationDivision as string) || (oRaw.Division as string) || "",
            BillToPartyCode: (oRaw.BillToPartyCode as string) || "",
            BillToPartyName: (oRaw.BillToPartyName as string) || "",
            ShipToPartyCode: (oRaw.ShipToPartyCode as string) || "",
            ShipToPartyName: (oRaw.ShipToPartyName as string) || "",
            CustomerPONumber: (oRaw.CustomerPONumber as string) || "",
            MaterialCode: (oRaw.MaterialCode as string) || "",
            MaterialDescription: (oRaw.MaterialDescription as string) || "",
            CustomerMaterialCode: (oRaw.CustomerMaterialCode as string) || "",
            Plant: (oRaw.Plant as string) || "",
            BillingQuantity: (oRaw.BillingQuantity as string) || "",
            OriginalRate: (oRaw.OriginalRate as string) || "",
            ItemNetValueTotal: (oRaw.ItemNetValueTotal as string) || "",
            BillingDate: (oRaw.BillingDate as string) || "",
            NewRate: RATE_LOADING,
            NewAmount: RATE_LOADING,
            RateDifference: RATE_LOADING,
            RetroBillingAmount: RATE_LOADING,
            FinalRetroBillingAmount: RATE_LOADING,
            // "OriginalDiscount" is screen 1's raw OData field name (see
            // retrobillingapp.view.xml's initiallyVisibleFields /
            // requestAtLeastFields) - carried forward unchanged, same as
            // OriginalRate above.
            OriginalDiscountPercent: (oRaw.OriginalDiscount as string) || "",
            NewDiscountPercent: RATE_LOADING,
            NewDiscountAmount: RATE_LOADING,
            SalesOrderGroupLabel: "",
            SalesOrderGroupIndex: Number.MAX_SAFE_INTEGER
        }));

        const oPostModel = new JSONModel({
            allRows: aRows,
            rows: aRows,
            salesOrderCrDrDate: "",
            // Default filter selection: "Yes" - applied immediately below.
            showOnlyRetroBillingValue: "Y" as TRetroBillingFilterKey,
            visibleCountDisplayText: "",
            splitMaterialWise: bSplitMaterialWise,
            splitPurchaseOrderWise: bSplitPurchaseOrderWise,
            salesOrganization: sSalesOrganization,
            salesOrderGroupSummaryText: ""
        });
        this.getView()?.setModel(oPostModel, "postModel");

        // Groups depend on RetroBillingAmount's sign (3rd priority), which
        // isn't known yet until rates load - this first pass just seeds
        // "/rows" and the summary text with an accurate "0 groups yet"
        // state; _applyRateToMatchingRows recomputes it as each rate lands.
        this._computeSalesOrderGroups(oPostModel);
        this._applyRetroBillingValueFilter(oPostModel);
        this._attachGroupBanding();

        this._fetchRatesForRows(aRows, oPostModel);
    }

    /**
     * One-time attachment of a "rowsUpdated" listener on the inner
     * sap.ui.table.Table that paints alternating background bands per
     * Sales Order group (using SalesOrderGroupIndex from each row's
     * binding context), so groups are visually distinguishable in the
     * table without changing its underlying control type. Mirrors the
     * same DOM-banding approach already used for F2 highlighting on
     * screen 1.
     */
    private _attachGroupBanding(): void {
        if (this._bGroupBandingAttached) {
            return;
        }
        const oTable = this.byId("postCrDrTable") as Table | undefined;
        if (!oTable) {
            return;
        }
        oTable.attachRowsUpdated(() => this._applyGroupBandColors(oTable));
        this._bGroupBandingAttached = true;
    }

    /**
     * Walks the currently rendered rows and colors each one according to
     * its SalesOrderGroupIndex (alternating between two shades as the
     * group index changes), so consecutive rows belonging to the same
     * Sales Order group share a background and a new group is visually
     * obvious the moment the index changes. Rows with no group (not
     * Yes-belonging) are left uncolored.
     */
    private _applyGroupBandColors(oTable: Table): void {
        const oTableDomRef = oTable.getDomRef();
        if (!oTableDomRef) {
            return;
        }

        let iLastGroupIndex: number | undefined;
        let iColorCursor = 0;

        oTable.getRows().forEach((oRow, iVisualIndex) => {
            const oCtx = oRow.getBindingContext("postModel");
            const oData = oCtx && (oCtx.getObject() as IPostCrDrRow | undefined);

            const aTrs = oTableDomRef.querySelectorAll<HTMLTableRowElement>(
                `tr[data-sap-ui-rowindex="${iVisualIndex}"]`
            );

            if (!oData || oData.SalesOrderGroupIndex === Number.MAX_SAFE_INTEGER) {
                aTrs.forEach((oTr) => oTr.style.removeProperty("background-color"));
                return;
            }

            if (oData.SalesOrderGroupIndex !== iLastGroupIndex) {
                iLastGroupIndex = oData.SalesOrderGroupIndex;
                iColorCursor = (iColorCursor + 1) % PostCrDr.GROUP_BAND_COLORS.length;
            }

            aTrs.forEach((oTr) => {
                oTr.style.setProperty("background-color", PostCrDr.GROUP_BAND_COLORS[iColorCursor], "important");
            });
        });
    }

    /**
     * Fired on "change" of the Sales Order CR/DR Date DatePicker. Gives
     * immediate visual feedback (value state) if what the user typed
     * doesn't parse as a valid date in the configured display format.
     */
    public onSalesOrderCrDrDateChange(oEvent: Event): void {
        const oDatePicker = oEvent.getSource() as DatePicker;
        const bValid = oDatePicker.isValidValue();

        if (!bValid) {
            oDatePicker.setValueState("Error");
            oDatePicker.setValueStateText("Please enter a valid date in DD.MM.YYYY format.");
            return;
        }

        const oSelectedDate = oDatePicker.getDateValue();
        const oToday = new Date();
        oToday.setHours(0, 0, 0, 0);

        if (oSelectedDate && oSelectedDate < oToday) {
            oDatePicker.setValueState("Error");
            oDatePicker.setValueStateText("Backdated Sales Order CR/DR Date is not allowed.");
            return;
        }

        oDatePicker.setValueState("None");
        oDatePicker.setValueStateText("");
    }

    /**
     * Mandatory-field guard for Sales Order CR/DR Date. Call this before
     * whatever "Post" action ultimately submits this screen's data, and
     * bail out if it returns false.
     */
    private _validateSalesOrderCrDrDate(): boolean {
        const oDatePicker = this.byId("inpSalesOrderCrDrDate") as DatePicker;
        const sValue = oDatePicker.getValue();

        if (!sValue || !oDatePicker.isValidValue()) {
            oDatePicker.setValueState("Error");
            oDatePicker.setValueStateText("Sales Order CR/DR Date is mandatory.");
            MessageToast.show("Please enter Sales Order CR/DR Date.");
            return false;
        }

        const oSelectedDate = oDatePicker.getDateValue();
        const oToday = new Date();
        oToday.setHours(0, 0, 0, 0);

        if (oSelectedDate && oSelectedDate < oToday) {
            oDatePicker.setValueState("Error");
            oDatePicker.setValueStateText("Backdated Sales Order CR/DR Date is not allowed.");
            MessageToast.show("Sales Order CR/DR Date cannot be a past date.");
            return false;
        }

        oDatePicker.setValueState("None");
        return true;
    }

    /**
     * Posting always builds its Sales Order groups from the Yes-belonging
     * rows only (see _buildMemoRequestPayloads -> _getYesBelongingRows),
     * regardless of what the "Show Only Retro Billing Value" dropdown is
     * currently displaying. To avoid the user posting while looking at
     * "No" or "All" and being confused about what actually got posted,
     * the dropdown itself must be set to "Yes" before Post is allowed.
     */
    private _validateShowOnlyRetroBillingValueIsYes(oPostModel: JSONModel): boolean {
        const sFilterKey = oPostModel.getProperty("/showOnlyRetroBillingValue") as TRetroBillingFilterKey;
        if (sFilterKey !== "Y") {
            MessageBox.error("Please select 'Yes' in 'Show only Retro Billing Value'");
            return false;
        }
        return true;
    }

    /**
     * Fired the moment the user changes the "Show Only Retro Billing
     * Value" dropdown. Immediately re-derives "/rows" from "/allRows" -
     * no separate confirmation step.
     */
    public onShowOnlyRetroBillingValueChange(): void {
        const oPostModel = this.getView()?.getModel("postModel") as JSONModel | undefined;
        if (oPostModel) {
            this._applyRetroBillingValueFilter(oPostModel);
        }
    }

    /** Maps the "Show Only Retro Billing Value" filter key to the word used in the exported file name. */
    private static readonly EXPORT_FILTER_LABEL: Record<TRetroBillingFilterKey, string> = {
        Y: "Yes",
        N: "No",
        A: "All"
    };

    /**
     * Builds a "YYYYMMDD_HHmmss" timestamp (local time) for the exported
     * file name - sortable, and avoids characters (":", " ") that are
     * awkward or invalid in file names on some OSes.
     */
    private _buildExportTimestamp(): string {
        const oNow = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        return (
            `${oNow.getFullYear()}${pad(oNow.getMonth() + 1)}${pad(oNow.getDate())}` +
            `_${pad(oNow.getHours())}${pad(oNow.getMinutes())}${pad(oNow.getSeconds())}`
        );
    }

    /**
     * Exports exactly what's currently visible in the table - i.e.
     * "/rows" on postModel, which is already filtered to whatever "Show
     * Only Retro Billing Value" is currently set to (see
     * _applyRetroBillingValueFilter) - as an Excel (.xlsx) file, with one
     * column per column shown in the table (same order, same labels).
     *
     * File name: RetroBill_<YYYYMMDD_HHmmss>_<Yes|No|All>.xlsx, where the
     * last part reflects the dropdown's current selection at export time.
     */
    public onExportPressed(): void {
        const oPostModel = this.getView()?.getModel("postModel") as JSONModel | undefined;
        if (!oPostModel) {
            return;
        }

        const aRows = (oPostModel.getProperty("/rows") as IPostCrDrRow[]) || [];
        if (aRows.length === 0) {
            MessageToast.show("There are no visible rows to export.");
            return;
        }

        const sFilterKey = (oPostModel.getProperty("/showOnlyRetroBillingValue") as TRetroBillingFilterKey) || "Y";
        const sFilterLabel = PostCrDr.EXPORT_FILTER_LABEL[sFilterKey] || "All";
        const sFileName = `RetroBill_${this._buildExportTimestamp()}_${sFilterLabel}`;

        // One entry per column currently shown in the table (see
        // PostCrDr.view.xml#postCrDrTable), same order/labels as the UI.
        const aColumns = [
            { label: "Sales Order Group", property: "SalesOrderGroupLabel", type: EdmType.String },
            { label: "Parent Billing Document", property: "ParentBillingDocument", type: EdmType.String },
            { label: "Billing Document Item", property: "BillingDocumentItem", type: EdmType.String },
            { label: "ODN Number", property: "ODNNumber", type: EdmType.String },
            { label: "Sales Org", property: "SalesOrganization", type: EdmType.String },
            { label: "Bill To Party Code", property: "BillToPartyCode", type: EdmType.String },
            { label: "Bill To Party Name", property: "BillToPartyName", type: EdmType.String },
            { label: "Ship To Party Code", property: "ShipToPartyCode", type: EdmType.String },
            { label: "Ship To Party Name", property: "ShipToPartyName", type: EdmType.String },
            { label: "Customer PO Number", property: "CustomerPONumber", type: EdmType.String },
            { label: "Material Code", property: "MaterialCode", type: EdmType.String },
            { label: "Material Description", property: "MaterialDescription", type: EdmType.String },
            { label: "Customer Material Code", property: "CustomerMaterialCode", type: EdmType.String },
            { label: "Plant", property: "Plant", type: EdmType.String },
            { label: "Billing Quantity", property: "BillingQuantity", type: EdmType.Number },
            { label: "Original Rate", property: "OriginalRate", type: EdmType.Number },
            { label: "New Rate", property: "NewRate", type: EdmType.String },
            { label: "Rate Difference", property: "RateDifference", type: EdmType.String },
            { label: "Original Discount Percent", property: "OriginalDiscountPercent", type: EdmType.Number },
            { label: "New Discount Percent", property: "NewDiscountPercent", type: EdmType.String },
            { label: "New Amount", property: "NewAmount", type: EdmType.String },
            { label: "New Discount Amount", property: "NewDiscountAmount", type: EdmType.String },
            { label: "Item Net Value Total", property: "ItemNetValueTotal", type: EdmType.String },
            { label: "Retro Billing Amount", property: "RetroBillingAmount", type: EdmType.String }
        ];

        const oSpreadsheet = new Spreadsheet({
            workbook: {
                columns: aColumns,
                context: {
                    sheetName: "Retro Billing"
                }
            },
            dataSource: aRows,
            fileName: `${sFileName}.xlsx`
        });

        oSpreadsheet
            .build()
            .catch((oError: unknown) => {
                // eslint-disable-next-line no-console
                console.error("[Export] Failed to build spreadsheet:", oError);
                MessageToast.show("Export failed. Please try again.");
            })
            .finally(() => {
                oSpreadsheet.destroy();
            });
    }

    /**
     * Order Type per Sales Order group: "DR" for a group whose rows are
     * all positive Retro Billing Amount, "CR" for all-negative. Per the
     * 3rd grouping priority, a group is never a mix of the two, so it's
     * safe to read the sign off any one row in the group (the first).
     *
     * NOTE: "DR"/"CR" are placeholders for whatever your actual SAP
     * CreditMemoRequestType/DebitMemoRequestType codes are (commonly
     * something like "ZDR"/"ZCR" in a customer system) - confirm the
     * real codes before going live.
     */
    private static readonly ORDER_TYPE_DEBIT: TMemoDocType = "DR";
    private static readonly ORDER_TYPE_CREDIT: TMemoDocType = "CR";

    /**
     * Converts the Final Retro Billing Amount into the string posted as the
     * DPR1 ConditionRateValue: absolute value, rounded to 2 decimals.
     * The backend rejects anything with more than 2 decimal places
     * ("Too many decimal places (maximum 2)"), so the full-precision
     * Final amount (e.g. 315.21825) is rounded only here, at posting time
     * (-> "315.22"). Math.round with EPSILON avoids float edge cases like
     * 1.005 -> 1.00.
     */
    private static _toPostableAmount(sAmount: string): string {
        const fAbs = Math.abs(Number.parseFloat(sAmount) || 0);
        const fRounded = Math.round((fAbs + Number.EPSILON) * 100) / 100;
        return fRounded.toFixed(2);
    }

    /** Fixed per the mapping you gave - Order Reason is always "200". */
    private static readonly ORDER_REASON = "200";

    /** Condition Type posted per item to carry the Retro Billing Amount as a manual pricing condition. */
    private static readonly RETRO_CONDITION_TYPE = "DPR1";

    /** Currency for the DPR1 condition's ConditionRateValue - confirm this matches your document/transaction currency (sample data showed "INR"). */
    private static readonly RETRO_CONDITION_CURRENCY = "INR";

    /** Ship-To Party has no flat header field on A_CreditMemoRequest/A_DebitMemoRequest - it must be created as a to_Partner entry with this function code. */
    private static readonly PARTNER_FUNCTION_SHIP_TO = "WE";

    /**
     * Fired when the user presses "Post". Builds one Credit Memo Request
     * or Debit Memo Request per Sales Order group (Yes-belonging rows
     * only) and posts each one via the matching OData V2 model -
     * "creditMemoRequestModel" (API_CREDIT_MEMO_REQUEST_SRV) for CR
     * groups, "debitMemoRequestModel" (API_DEBIT_MEMO_REQUEST_SRV) for DR
     * groups (see manifest.json) - using a single V2 deep-insert POST per
     * group (header + nested to_Partner + to_Item all in one request).
     * These are two separate APIs/entity sets, so which one a group hits
     * depends entirely on that group's docType ("CR" or "DR").
     */
    public async onPostPressed(): Promise<void> {
        const oPostModel = this.getView()?.getModel("postModel") as JSONModel | undefined;
        if (!oPostModel) {
            return;
        }

        if (!this._validateSalesOrderCrDrDate()) {
            return;
        }

        if (!this._validateShowOnlyRetroBillingValueIsYes(oPostModel)) {
            return;
        }

        const oCreditMemoRequestModel = this.getOwnerComponent()?.getModel("creditMemoRequestModel") as ODataModel | undefined;
        const oDebitMemoRequestModel = this.getOwnerComponent()?.getModel("debitMemoRequestModel") as ODataModel | undefined;
        if (!oCreditMemoRequestModel || !oDebitMemoRequestModel) {
            MessageBox.error(
                "Credit/Debit Memo Request OData models ('creditMemoRequestModel' / 'debitMemoRequestModel') " +
                "are not configured - check manifest.json."
            );
            return;
        }

        const aGroupPayloads = this._buildMemoRequestPayloads(oPostModel);
        if (aGroupPayloads.length === 0) {
            MessageBox.information("There are no Yes-belonging records to post.");
            return;
        }

        this.getView()?.setBusy(true);

        const aResults: Array<{ groupLabel: string; docType: TMemoDocType; success: boolean; docNumber?: string; error?: string }> = [];

        // Posted sequentially, one group at a time - simpler to reason
        // about and to report per-group failures than firing all groups
        // in parallel, and Credit/Debit Memo Request creation volume here
        // is small (a handful of groups at most). Each post goes through
        // oModel.create() (see _postSingleMemoRequest), which handles its
        // own CSRF token fetch/refresh internally per SAPUI5's ODataModel
        // v2 implementation.
        for (const oGroupPayload of aGroupPayloads) {
            const oModel = oGroupPayload.docType === "CR" ? oCreditMemoRequestModel : oDebitMemoRequestModel;
            const sEntitySet = oGroupPayload.docType === "CR" ? "/A_CreditMemoRequest" : "/A_DebitMemoRequest";
            try {
                const sDocNumber = await this._postSingleMemoRequest(oModel, sEntitySet, oGroupPayload);
                aResults.push({ groupLabel: oGroupPayload.groupLabel, docType: oGroupPayload.docType, success: true, docNumber: sDocNumber });
            } catch (oError) {
                aResults.push({
                    groupLabel: oGroupPayload.groupLabel,
                    docType: oGroupPayload.docType,
                    success: false,
                    error: oError instanceof Error ? oError.message : String(oError)
                });
            }
        }

        this.getView()?.setBusy(false);

        const iSuccessCount = aResults.filter((r) => r.success).length;
        const iFailCount = aResults.length - iSuccessCount;

        const fnLabel = (r: { docType: TMemoDocType }) => (r.docType === "CR" ? "Credit Memo Request" : "Debit Memo Request");

        if (iFailCount === 0) {
            MessageBox.success(
                `${iSuccessCount} document${iSuccessCount === 1 ? "" : "s"} posted successfully:\n` +
                aResults.map((r) => `${r.groupLabel} -> ${fnLabel(r)} ${r.docNumber}`).join("\n"),
                { onClose: () => this._navBackToScreen1AndReset() }
            );
        } else {
            // eslint-disable-next-line no-console
            console.error("[onPostPressed] Failed Credit/Debit Memo Request group(s):", aResults.filter((r) => !r.success));
            MessageBox.warning(
                `${iSuccessCount} of ${aResults.length} document(s) posted successfully. ` +
                `${iFailCount} failed - see browser console for details.\n\n` +
                aResults.map((r) => `${r.groupLabel} (${fnLabel(r)}): ${r.success ? "OK (" + r.docNumber + ")" : "FAILED - " + r.error}`).join("\n"),
                { onClose: () => this._navBackToScreen1AndReset() }
            );
        }
    }

    /**
     * Fired when the user dismisses the post-result dialog (the
     * MessageBox.success/warning shown at the end of onPostPressed above)
     * - whether every group posted cleanly or some/all failed. Per
     * requirement, closing that dialog always sends the user back to
     * screen 1 with a clean slate: the SmartFilterBar's own fields
     * (Payer, Ship-To, Sales Organization, Plant, Material Code) reset to
     * empty/initial via SmartFilterBar#clear(), the custom Billing Date
     * From/To fields (which live outside the SmartFilterBar's own field
     * engine - see onPostCrDr's comment on filterModel) reset alongside
     * them, and the table itself goes back to empty rather than showing
     * whatever was last loaded - all handled by
     * retrobillingapp.controller.ts#_onRouteMatched picking up the
     * "/resetScreen1" flag set here.
     *
     * The flag (rather than calling screen 1's controller directly) is
     * used because the router caches each route's view/controller
     * instance - there's no reliable, version-proof way to reach into
     * another cached controller instance from here, but both controllers
     * already share the "selectedInvoices" component model (screen 1
     * writes to it in onPostCrDr, this screen reads it in
     * _onRouteMatched), so it doubles as a lightweight signal channel
     * too.
     */
    private _navBackToScreen1AndReset(): void {
        const oComponent = this.getOwnerComponent() as UIComponent;
        const oSelectedModel = oComponent.getModel("selectedInvoices") as JSONModel | undefined;
        oSelectedModel?.setProperty("/resetScreen1", true);

        const oRouter = oComponent.getRouter();
        oRouter.navTo("Routeretrobillingapp");
    }

    /**
     * Posts a single Credit/Debit Memo Request via the native
     * ODataModel#create() (V2 model API), instead of raw fetch() with a
     * manual X-CSRF-Token: Fetch / POST dance.
     *
     * WHY THE CHANGE: the reference "inhouserejectiontest" app (uploaded
     * separately), which posts its MIGO document successfully both
     * locally AND once deployed, does its create via
     * oModel.create("/A_MaterialDocumentHeader", payload, { success,
     * error }) - it does not touch fetch() or CSRF headers anywhere in
     * its code (grep confirms zero "csrf"/"fetch(" hits in that project's
     * webapp/). The CSRF token fetch + retry is handled entirely inside
     * SAPUI5's ODataModel v2 implementation.
     *
     * The raw-fetch approach here failed on the deployed (approuter/CF)
     * environment specifically because the token GET and the write POST
     * are two independent fetch() calls with no shared XHR/session
     * bookkeeping the way the model provides internally - even with
     * credentials:"include" and no timing gap, a load-balanced backend or
     * an approuter re-route can still land the two calls on paths that
     * don't agree on the token. ODataModel's own internal request pipeline
     * (used by create()) is what SAP's own apps rely on for exactly this
     * scenario, including automatic silent token refresh + a single retry
     * if the server responds 403 with a stale token - so switching to it
     * removes the class of problem entirely rather than trying to patch
     * the manual token dance further.
     */
    private _postSingleMemoRequest(
        oModel: ODataModel,
        sEntitySet: string,
        oGroupPayload: IMemoGroupPayload
    ): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const sSecurityToken = oModel.getSecurityToken();
            // eslint-disable-next-line no-console
            console.log(
                `[PostCrDr] About to create ${sEntitySet} - ` +
                `security token in use (first 12 chars): "${(sSecurityToken || "").slice(0, 12)}...", ` +
                `serviceUrl: ${oModel.getServiceUrl()}, useBatch: ${(oModel as unknown as { bUseBatch?: boolean }).bUseBatch}`
            );

            oModel.create(sEntitySet, oGroupPayload.payload, {
                success: (oData: Record<string, unknown>, oResponse?: { statusCode?: string | number; headers?: Record<string, string> }) => {
                    // eslint-disable-next-line no-console
                    console.log(`[PostCrDr] ${sEntitySet} create SUCCESS`, {
                        statusCode: oResponse?.statusCode,
                        responseHeaders: oResponse?.headers
                    });
                    const sDocNumber = oGroupPayload.docType === "CR" ? oData?.CreditMemoRequest : oData?.DebitMemoRequest;
                    resolve(String(sDocNumber ?? ""));
                },
                error: (oError: {
                    message?: string;
                    response?: {
                        body?: string;
                        statusCode?: string | number;
                        statusText?: string;
                        headers?: Record<string, string>;
                        requestUri?: string;
                    };
                }) => {
                    // Full diagnostic dump - this is the key evidence needed to
                    // tell a client-side CSRF bug (token never obtained/sent)
                    // apart from a backend/session-affinity rejection (token
                    // obtained and sent correctly, but the server that gets the
                    // write doesn't recognize it - visible as
                    // response headers containing "x-csrf-token: Required"
                    // even though the request sent a real token).
                    // eslint-disable-next-line no-console
                    console.error(`[PostCrDr] ${sEntitySet} create FAILED - full diagnostic dump:`, {
                        groupLabel: oGroupPayload.groupLabel,
                        requestUri: oError?.response?.requestUri,
                        statusCode: oError?.response?.statusCode,
                        statusText: oError?.response?.statusText,
                        responseHeaders: oError?.response?.headers,
                        responseBody: oError?.response?.body,
                        tokenSentWasPresent: !!sSecurityToken,
                        tokenSentPrefix: (sSecurityToken || "").slice(0, 12)
                    });

                    // If the response headers explicitly say the token is
                    // "Required" or "Invalid" despite us having sent one,
                    // this is the backend/session-affinity signature - log a
                    // pointed hint so it's obvious in the console without
                    // needing to inspect the Network tab.
                    const sResponseCsrfHeader =
                        oError?.response?.headers?.["x-csrf-token"] || oError?.response?.headers?.["X-CSRF-Token"];
                    if (sSecurityToken && sResponseCsrfHeader && /required|invalid/i.test(sResponseCsrfHeader)) {
                        // eslint-disable-next-line no-console
                        console.error(
                            `[PostCrDr] DIAGNOSIS: a valid-looking CSRF token WAS sent ` +
                            `("${sSecurityToken.slice(0, 12)}...") but the server responded ` +
                            `"x-csrf-token: ${sResponseCsrfHeader}" - the server did not recognize ` +
                            `the token it (or a peer instance) issued. This points to a backend/` +
                            `session-affinity issue (multiple app server instances not sharing CSRF/` +
                            `session state) in the destination/Cloud Connector/Web Dispatcher routing, ` +
                            `not an app-code CSRF bug. Escalate to Basis with this log.`
                        );
                    }

                    let sMessage = oError?.message || "Request failed";
                    const sBody = oError?.response?.body;
                    if (sBody) {
                        try {
                            const oParsed = JSON.parse(sBody) as { error?: { message?: { value?: string } | string } };
                            const vMessage = oParsed?.error?.message;
                            const sParsedMessage = typeof vMessage === "string" ? vMessage : vMessage?.value;
                            if (sParsedMessage) {
                                sMessage = sParsedMessage;
                            }
                        } catch {
                            // Non-JSON error body - keep oError.message as-is.
                        }
                    }
                    if (oError?.response?.statusCode) {
                        sMessage = `HTTP ${oError.response.statusCode} : ${sMessage}`;
                    }
                    reject(new Error(sMessage));
                }
            });
        });
    }

    /**
     * Builds one Credit Memo Request or Debit Memo Request payload per
     * Sales Order group, using only the Yes-belonging rows (see
     * _getYesBelongingRows) and the current grouping from
     * _computeSalesOrderGroups. Each group becomes exactly one header +
     * one Ship-To partner + one to_Item per row in that group ("Material
     * Invoice wise" - no aggregation across rows sharing a Material
     * within the same group).
     *
     * Field mapping, per your instructions:
     *   - docType / CreditMemoRequestType / DebitMemoRequestType: "DR"
     *     (Debit Memo Request, via API_DEBIT_MEMO_REQUEST_SRV) if the
     *     group's Retro Billing Amount is positive, "CR" (Credit Memo
     *     Request, via API_CREDIT_MEMO_REQUEST_SRV) if negative (never
     *     mixed within one group).
     *   - SalesOrganization: from screen 1's SmartFilterBar selection
     *     (forwarded via "/salesOrganization" on this model), not per row.
     *   - DistributionChannel / OrganizationDivision: from the OData
     *     service, taken off the group's rows (assumed consistent within
     *     a Bill-To/Ship-To group).
     *   - SoldToParty: Bill-To Party Code for this group.
     *   - Ship-To Party: posted as a to_Partner entry (function "WE"),
     *     since neither A_CreditMemoRequest nor A_DebitMemoRequest has a
     *     flat ShipToParty header field.
     *   - SDDocumentReason: fixed "200".
     *   - Items: one per row in the group, Material = MaterialCode,
     *     RequestedQuantity = BillingQuantity. Deliberately NOT including
     *     ReferenceSDDocument / ReferenceSDDocumentItem, per your
     *     instruction to leave those out at item level.
     *   - YY1_BillingRefNo_SDI (custom item field): ParentBillingDocument
     *     for that row - i.e. the original F2 invoice this item traces
     *     back to.
     *   - YY1_RetroBillingItemRe_SDI (custom item field): that row's
     *     BillingDocumentItem - i.e. the item number on the original F2
     *     invoice this item traces back to. Two earlier guessed names were
     *     rejected by the service ("Property '...' is invalid"):
     *     "YY1_BillingRefItm_SDI" and "YY1_RetroBillingItemRe_BDI". If this
     *     one is also rejected, confirm the exact custom field name via
     *     the Custom Fields app / metadata for A_CreditMemoRequestItem and
     *     A_DebitMemoRequestItem rather than guessing further.
     *   - to_PricingElement (one per item): a single manual pricing
     *     condition, ConditionType "DPR1", ConditionRateValue = the
     *     ABSOLUTE VALUE of that row's Retro Billing Amount (sign is
     *     display-only / used to pick CR vs DR - the posted rate itself
     *     is always positive), ConditionCurrency = "INR" (see
     *     RETRO_CONDITION_CURRENCY - ConditionAmount is deliberately NOT
     *     set here since it's a system-computed result field, not an
     *     input).
     *
     * Still open: currency, unit of measure on RequestedQuantity, the
     * exact CreditMemoRequestType/DebitMemoRequestType codes (currently
     * the "DR"/"CR" placeholders), and confirming the item-level pricing
     * element navigation property name/required fields against your
     * actual A_CreditMemoReqItemPrcgElmnt / A_DebitMemoReqItemPrcgElmnt
     * metadata.
     */
    private _buildMemoRequestPayloads(oPostModel: JSONModel): IMemoGroupPayload[] {
        const sSalesOrganization = (oPostModel.getProperty("/salesOrganization") as string) || "";
        const aYesRows = this._getYesBelongingRows(oPostModel);

        // Sales Order CR/DR Date the user selected on this screen (validated
        // as mandatory in _validateSalesOrderCrDrDate before we ever get
        // here) - posted at header level, unmodified, to PricingDate,
        // BillingDocumentDate, and to CreditMemoRequestDate/DebitMemoRequestDate on every group's
        // Credit/Debit Memo Request.
        //
        // IMPORTANT: DatePicker#getDateValue() returns a Date at LOCAL
        // midnight for the picked day (e.g. 17.07.2026 00:00 IST). If that
        // Date is sent as-is, the OData V2 model serializes it via
        // toJSON()/toISOString(), which converts to UTC first - for a
        // positive UTC offset (like IST, UTC+5:30) local midnight is still
        // the PREVIOUS day in UTC, so 17.07.2026 was silently posted as
        // 16.07.2026. Rebuilding the Date from the picked day's Y/M/D at UTC
        // midnight (Date.UTC) keeps the calendar date the user picked intact
        // regardless of the browser's/server's time zone.
        const oSalesOrderCrDrDatePicker = this.byId("inpSalesOrderCrDrDate") as DatePicker;
        const oPickedDate = oSalesOrderCrDrDatePicker.getDateValue() as Date;
        const oSalesOrderCrDrDate = new Date(Date.UTC(
            oPickedDate.getFullYear(),
            oPickedDate.getMonth(),
            oPickedDate.getDate()
        ));

        const mGroups: Record<string, IPostCrDrRow[]> = {};
        aYesRows.forEach((oRow) => {
            if (!mGroups[oRow.SalesOrderGroupLabel]) {
                mGroups[oRow.SalesOrderGroupLabel] = [];
            }
            mGroups[oRow.SalesOrderGroupLabel].push(oRow);
        });

        return Object.keys(mGroups).map((sGroupLabel) => {
            const aGroupRows = mGroups[sGroupLabel];
            const oFirstRow = aGroupRows[0];

            const sResolvedSalesOrg = oFirstRow.SalesOrganization || sSalesOrganization;
            const sResolvedDistrChannel = oFirstRow.DistributionChannel || "";
            const sResolvedDivision = oFirstRow.OrganizationDivision || oFirstRow.Division || "";

            // Fail fast with a clear message instead of letting the
            // backend reject with the opaque "sales area could not be
            // determined" error - this always means one of these three
            // is blank/missing on the source row (Z_RETRO_BILL_SCRN_SRV_BIND
            // is not returning it, or screen 1 is not selecting it).
            if (!sResolvedSalesOrg || !sResolvedDistrChannel || !sResolvedDivision) {
                // eslint-disable-next-line no-console
                console.error(
                    `[_buildMemoRequestPayloads] Missing sales area field(s) for group "${sGroupLabel}": ` +
                    `SalesOrganization="${sResolvedSalesOrg}", DistributionChannel="${sResolvedDistrChannel}", ` +
                    `Division/OrganizationDivision="${sResolvedDivision}". Source row:`,
                    oFirstRow
                );
                throw new Error(
                    `Cannot post "${sGroupLabel}": missing SalesOrganization, DistributionChannel, and/or ` +
                    `Division for this invoice. Check that Z_RETRO_BILL_SCRN_SRV_BIND returns these fields ` +
                    `for this row.`
                );
            }

            // Posting uses the FINAL Retro Billing Amount (Retro Billing
            // Amount + New Discount Percent applied on it), not the value
            // shown on screen.
            const fRetroAmount = parseFloat(oFirstRow.FinalRetroBillingAmount);
            // Positive Final Retro Billing Amount -> Debit Memo Request (DR),
            // negative -> Credit Memo Request (CR). Each group is one or
            // the other, never mixed (see _computeSalesOrderGroups).
            const sDocType: TMemoDocType = fRetroAmount >= 0 ? PostCrDr.ORDER_TYPE_DEBIT : PostCrDr.ORDER_TYPE_CREDIT;

            const oPartner = {
                PartnerFunction: PostCrDr.PARTNER_FUNCTION_SHIP_TO,
                Customer: oFirstRow.ShipToPartyCode
            };

            if (sDocType === "CR") {
                return {
                    groupLabel: sGroupLabel,
                    docType: sDocType,
                    payload: {
                        CreditMemoRequestType: sDocType,
                        SalesOrganization: sResolvedSalesOrg,
                        DistributionChannel: sResolvedDistrChannel,
                        OrganizationDivision: sResolvedDivision,
                        SoldToParty: oFirstRow.BillToPartyCode,
                        SDDocumentReason: PostCrDr.ORDER_REASON,
                        PricingDate: oSalesOrderCrDrDate,
                        BillingDocumentDate: oSalesOrderCrDrDate,
                        CreditMemoRequestDate: oSalesOrderCrDrDate,
                        to_Partner: [oPartner],
                        to_Item: aGroupRows.map((oRow, iIndex) => ({
                            CreditMemoRequestItem: String((iIndex + 1) * 10),
                            Material: oRow.MaterialCode,
                            MaterialByCustomer: oRow.CustomerMaterialCode,
                            PurchaseOrderByCustomer: (oRow.CustomerPONumber || "").trim().substring(0, 35),
                            RequestedQuantity: String(Number.parseFloat(oRow.BillingQuantity) || 0),
                            YY1_BillingRefNo_SDI: oRow.ParentBillingDocument,
                            YY1_RetroBillingItemRe_SDI: oRow.BillingDocumentItem,
                            to_PricingElement: [
                                {
                                    ConditionType: PostCrDr.RETRO_CONDITION_TYPE,
                                    // Posted rate is always positive - the +/- sign is only meaningful
                                    // for on-screen display and CR/DR grouping; the value posted is FinalRetroBillingAmount.
                                    ConditionRateValue: PostCrDr._toPostableAmount(oRow.FinalRetroBillingAmount),
                                    ConditionCurrency: PostCrDr.RETRO_CONDITION_CURRENCY
                                }
                            ]
                        }))
                    }
                };
            }

            return {
                groupLabel: sGroupLabel,
                docType: sDocType,
                payload: {
                    DebitMemoRequestType: sDocType,
                    SalesOrganization: sResolvedSalesOrg,
                    DistributionChannel: sResolvedDistrChannel,
                    OrganizationDivision: sResolvedDivision,
                    SoldToParty: oFirstRow.BillToPartyCode,
                    SDDocumentReason: PostCrDr.ORDER_REASON,
                    PricingDate: oSalesOrderCrDrDate,
                    BillingDocumentDate: oSalesOrderCrDrDate,
                    DebitMemoRequestDate: oSalesOrderCrDrDate,
                    to_Partner: [oPartner],
                    to_Item: aGroupRows.map((oRow, iIndex) => ({
                        DebitMemoRequestItem: String((iIndex + 1) * 10),
                        Material: oRow.MaterialCode,
                        MaterialByCustomer: oRow.CustomerMaterialCode,
                        PurchaseOrderByCustomer: (oRow.CustomerPONumber || "").trim().substring(0, 35),
                        RequestedQuantity: String(Number.parseFloat(oRow.BillingQuantity) || 0),
                        YY1_BillingRefNo_SDI: oRow.ParentBillingDocument,
                        YY1_RetroBillingItemRe_SDI: oRow.BillingDocumentItem,
                        to_PricingElement: [
                            {
                                ConditionType: PostCrDr.RETRO_CONDITION_TYPE,
                                // Posted rate is always positive - the +/- sign is only meaningful
                                // for on-screen display and CR/DR grouping; the value posted is FinalRetroBillingAmount.
                                ConditionRateValue: PostCrDr._toPostableAmount(oRow.FinalRetroBillingAmount),
                                ConditionCurrency: PostCrDr.RETRO_CONDITION_CURRENCY
                            }
                        ]
                    }))
                }
            };
        });
    }

    /**
     * Returns only the rows from "/allRows" that satisfy the "Yes"
     * condition (non-zero Rate Difference AND non-zero Retro Billing
     * Amount), independent of the dropdown's current selection. This is
     * the exact set that must become Sales Order line items on Post.
     */
    private _getYesBelongingRows(oPostModel: JSONModel): IPostCrDrRow[] {
        const aAllRows = (oPostModel.getProperty("/allRows") as IPostCrDrRow[]) || [];
        return aAllRows.filter((oRow) => this._matchesFilter(oRow, "Y"));
    }

    /**
     * Kicks off exactly ONE pricing-service call per distinct
     * (customer/ship-to/plant/material/sales-org/billing-date) key among
     * the selected rows - not one per row - then fans each result back
     * out to every row sharing that key. This is the whole point of
     * moving this logic here: screen 1 used to do this for every visible
     * row; here it only ever runs for the handful the user selected.
     */
    private _fetchRatesForRows(aRows: IPostCrDrRow[], oPostModel: JSONModel): void {
        const oOwnerComponent = this.getOwnerComponent();
        if (!oOwnerComponent) {
            return;
        }
        const oPricingModel = oOwnerComponent.getModel("pricingConditionService") as ODataModel;

        // Same params (Customer/ShipToParty/Plant/Material/SalesOrganization/
        // BillingDate) drive both lookups - only the ConditionType differs
        // (ZPR0 for New Rate, Z007 for New Discount Percent) - so the raw
        // params map is shared, but each ConditionType gets its own
        // buildKey()'d key (see PricingService.buildKey) and its own
        // dedup/fan-out pass below, exactly mirroring how New Rate already
        // worked.
        const mKeyToParams: Record<string, IConditionRateParams> = {};

        aRows.forEach((oRow) => {
            mKeyToParams[buildKey(this._toConditionRateParams(oRow), CONDITION_TYPE_RATE)] = this._toConditionRateParams(oRow);
        });
        Object.keys(mKeyToParams).forEach((sKey) => {
            fetchConditionRate(mKeyToParams[sKey], oPricingModel, CONDITION_TYPE_RATE).then((sRate) => {
                this._mRateCache[sKey] = sRate;
                this._applyRateToMatchingRows(sKey, sRate, oPostModel);
            });
        });

        const mDiscountKeyToParams: Record<string, IConditionRateParams> = {};
        aRows.forEach((oRow) => {
            mDiscountKeyToParams[buildKey(this._toConditionRateParams(oRow), CONDITION_TYPE_DISCOUNT)] = this._toConditionRateParams(oRow);
        });
        Object.keys(mDiscountKeyToParams).forEach((sKey) => {
            fetchConditionRate(mDiscountKeyToParams[sKey], oPricingModel, CONDITION_TYPE_DISCOUNT).then((sDiscountPercent) => {
                this._mDiscountCache[sKey] = sDiscountPercent;
                this._applyDiscountToMatchingRows(sKey, sDiscountPercent, oPostModel);
            });
        });
    }

    private _toConditionRateParams(oRow: IPostCrDrRow): IConditionRateParams {
        return {
            Customer: oRow.BillToPartyCode,
            ShipToParty: oRow.ShipToPartyCode,
            Plant: oRow.Plant,
            Material: oRow.MaterialCode,
            SalesOrganization: oRow.SalesOrganization,
            BillingDate: oRow.BillingDate
        };
    }

    /**
     * Once a rate comes back for a given key, writes New Rate / Rate
     * Difference / Retro Billing Amount onto every row in "/allRows" that
     * shares that key, then re-derives the filtered "/rows" (and its
     * count) so the table and count reflect both the newly-arrived rate
     * AND the currently selected dropdown option.
     */
    private _applyRateToMatchingRows(sKey: string, sRate: string, oPostModel: JSONModel): void {
        const aAllRows = (oPostModel.getProperty("/allRows") as IPostCrDrRow[]) || [];

        aAllRows.forEach((oRow) => {
            if (buildKey(this._toConditionRateParams(oRow), CONDITION_TYPE_RATE) !== sKey) {
                return;
            }

            oRow.NewRate = sRate;
            // CBRE ONLY: New Amount is negated relative to the normal F2
            // calculation (New Rate * Billing Quantity). F2 rows - and
            // anything else that isn't CBRE - are completely unaffected;
            // Retro Billing Amount's own formula is untouched either way
            // and simply uses whatever NewAmount/NewRate ends up being.
            oRow.NewAmount =
                oRow.BillingType === "CBRE"
                    ? negateAmount(computeNewAmount(sRate, oRow.BillingQuantity))
                    : computeNewAmount(sRate, oRow.BillingQuantity);
            if (sRate === RATE_NOT_FOUND) {
                oRow.RateDifference = RATE_NOT_FOUND;
            } else {
                oRow.RateDifference = computeRateDifference(sRate, oRow.OriginalRate);
            }
            this._recomputeNewDiscountAmount(oRow);
            this._recomputeRetroBillingAmount(oRow);
        });

        oPostModel.setProperty("/allRows", aAllRows);
        this._computeSalesOrderGroups(oPostModel);
        this._applyRetroBillingValueFilter(oPostModel);
    }

    /**
     * Same fan-out pattern as _applyRateToMatchingRows, but for New
     * Discount Percent (ConditionType Z007). Runs fully independently of
     * the New Rate fetch - whichever of the two arrives first just leaves
     * New Discount Amount at RATE_NOT_FOUND until the other one lands (see
     * _recomputeNewDiscountAmount, which needs both).
     */
    private _applyDiscountToMatchingRows(sKey: string, sDiscountPercent: string, oPostModel: JSONModel): void {
        const aAllRows = (oPostModel.getProperty("/allRows") as IPostCrDrRow[]) || [];

        aAllRows.forEach((oRow) => {
            if (buildKey(this._toConditionRateParams(oRow), CONDITION_TYPE_DISCOUNT) !== sKey) {
                return;
            }

            oRow.NewDiscountPercent = sDiscountPercent;
            this._recomputeNewDiscountAmount(oRow);
            this._recomputeRetroBillingAmount(oRow);
        });

        oPostModel.setProperty("/allRows", aAllRows);
        // New Rate (ZPR0) and New Discount Percent (Z007) resolve
        // independently and in either order. _applyRateToMatchingRows
        // already recomputes the Sales Order groups when it lands, but
        // when Z007 is the lookup that lands LAST for a row (very common,
        // since it's a separate request), it's this callback - not the
        // rate one - that actually finalizes that row's RetroBillingAmount
        // and therefore its Yes/No membership and group key. Without
        // recomputing here too, that row (frequently the last group to
        // form) never gets a SalesOrderGroupLabel written, leaving the
        // Sales Order Group column blank for it.
        this._computeSalesOrderGroups(oPostModel);
        this._applyRetroBillingValueFilter(oPostModel);
    }

    /**
     * New Discount Amount = New Rate * Billing Quantity * (New Discount
     * Percent / 100). Only computable once BOTH New Rate and New Discount
     * Percent have resolved to real numeric values (neither is still
     * RATE_LOADING nor RATE_NOT_FOUND) - until then (or if either lookup
     * came back not-found), stays RATE_NOT_FOUND, same convention as the
     * other derived columns.
     */
    private _recomputeNewDiscountAmount(oRow: IPostCrDrRow): void {
        if (oRow.NewRate === RATE_LOADING || oRow.NewDiscountPercent === RATE_LOADING) {
            oRow.NewDiscountAmount = RATE_LOADING;
            return;
        }
        oRow.NewDiscountAmount = computeNewDiscountAmount(oRow.NewRate, oRow.BillingQuantity, oRow.NewDiscountPercent);
    }

    /**
     * Retro Billing Amount = (New Amount - ItemNetValueTotal) - New
     * Discount Amount, where New Amount is the already-resolved
     * NewAmount field (New Rate * Billing Quantity for F2, negated for
     * CBRE - see PricingService's negateAmount) rather than a fresh
     * New Rate * Billing Quantity recalculation - this is what makes
     * CBRE's negated New Amount flow through into Retro Billing Amount.
     * Depends on BOTH the New Rate (ZPR0) and New Discount Percent (Z007)
     * lookups, which resolve independently and in either order - so this
     * is called from both _applyRateToMatchingRows and
     * _applyDiscountToMatchingRows, and stays at RATE_LOADING until both
     * New Rate and New Discount Percent have resolved. A New Discount
     * Percent that resolves to "not found" (no Z007 record for this row)
     * is NOT treated as still-loading - it finalizes the amount with zero
     * discount, via applyDiscountToRetroBillingAmount().
     */
    private _recomputeRetroBillingAmount(oRow: IPostCrDrRow): void {
        if (oRow.NewRate === RATE_LOADING) {
            oRow.RetroBillingAmount = RATE_LOADING;
            oRow.FinalRetroBillingAmount = RATE_LOADING;
            return;
        }
        if (oRow.NewRate === RATE_NOT_FOUND) {
            oRow.RetroBillingAmount = RATE_NOT_FOUND;
            oRow.FinalRetroBillingAmount = RATE_NOT_FOUND;
            return;
        }
        if (oRow.NewDiscountPercent === RATE_LOADING) {
            // New Rate is known, but we don't yet know whether a discount
            // applies - wait rather than finalizing without it.
            oRow.RetroBillingAmount = RATE_LOADING;
            oRow.FinalRetroBillingAmount = RATE_LOADING;
            return;
        }

        const sBaseRetroBillingAmount = computeRetroBillingAmountFromNewAmount(oRow.NewAmount, oRow.ItemNetValueTotal);
        oRow.RetroBillingAmount = applyDiscountToRetroBillingAmount(sBaseRetroBillingAmount, oRow.NewDiscountAmount);
        // Displayed value stays RetroBillingAmount. The Final amount (that
        // value + New Discount Percent applied on it, ADDED) is what gets posted.
        oRow.FinalRetroBillingAmount = computeFinalRetroBillingAmount(oRow.RetroBillingAmount, oRow.NewDiscountPercent);
    }

    /**
     * Builds the Sales Order groups per the 3 priorities, and writes
     * SalesOrderGroupLabel/SalesOrderGroupIndex onto every row in
     * "/allRows" (Yes-belonging rows get a real group; everything else -
     * No/loading/not-found rows - gets blank/MAX_SAFE_INTEGER, since only
     * Yes rows are ever actually posted). Also updates
     * "/salesOrderGroupSummaryText" with a plain count of how many
     * separate Sales Orders will be created.
     *
     * Grouping rules, applied in order:
     *   1st priority - same Bill-To AND same Ship-To => same group,
     *      different Bill-To/Ship-To combination => separate group.
     *   2nd priority - within a 1st-priority group, if "Split Material
     *      Wise" is checked, further split by Material Code; if "Split
     *      Purchase Order Wise" is checked, further split by Customer PO
     *      Number. Both can apply at once (split by the combination of
     *      both), independently of each other.
     *   3rd priority - within whatever group results from the above, rows
     *      with a positive Retro Billing Amount go in one group and rows
     *      with a negative Retro Billing Amount go in another - a single
     *      Sales Order is never a mix of positive and negative amounts.
     *
     * Groups are numbered in first-seen order purely for a stable,
     * readable label/banding sequence - the number itself carries no
     * business meaning.
     */
    private _computeSalesOrderGroups(oPostModel: JSONModel): void {
        const aAllRows = (oPostModel.getProperty("/allRows") as IPostCrDrRow[]) || [];
        const bSplitMaterialWise = !!oPostModel.getProperty("/splitMaterialWise");
        const bSplitPurchaseOrderWise = !!oPostModel.getProperty("/splitPurchaseOrderWise");

        // Reset every row first - rows that don't (or no longer) qualify
        // as Yes must never keep a stale group from an earlier rate value.
        aAllRows.forEach((oRow) => {
            oRow.SalesOrderGroupLabel = "";
            oRow.SalesOrderGroupIndex = Number.MAX_SAFE_INTEGER;
        });

        const aYesRows = aAllRows.filter((oRow) => this._matchesFilter(oRow, "Y"));

        const mGroupKeyToIndex: Record<string, number> = {};
        const mGroupKeyToLabel: Record<string, string> = {};
        let iNextGroupIndex = 0;

        aYesRows.forEach((oRow) => {
            const fRetroAmount = parseFloat(oRow.RetroBillingAmount);
            const sSignKey = fRetroAmount >= 0 ? "POS" : "NEG";
            const sSignLabel = fRetroAmount >= 0 ? "Positive" : "Negative";

            const aKeyParts = [`BT:${oRow.BillToPartyCode}`, `ST:${oRow.ShipToPartyCode}`];
            const aLabelParts = [`Bill-To ${oRow.BillToPartyCode}`, `Ship-To ${oRow.ShipToPartyCode}`];

            if (bSplitMaterialWise) {
                aKeyParts.push(`MAT:${oRow.MaterialCode}`);
                aLabelParts.push(`Material ${oRow.MaterialCode}`);
            }
            if (bSplitPurchaseOrderWise) {
                aKeyParts.push(`PO:${oRow.CustomerPONumber}`);
                aLabelParts.push(`PO ${oRow.CustomerPONumber}`);
            }
            aKeyParts.push(sSignKey);
            aLabelParts.push(sSignLabel);

            const sGroupKey = aKeyParts.join("|");

            if (!(sGroupKey in mGroupKeyToIndex)) {
                mGroupKeyToIndex[sGroupKey] = iNextGroupIndex;
                mGroupKeyToLabel[sGroupKey] = `Sales Order ${iNextGroupIndex + 1}: ${aLabelParts.join(" / ")}`;
                iNextGroupIndex++;
            }

            oRow.SalesOrderGroupIndex = mGroupKeyToIndex[sGroupKey];
            oRow.SalesOrderGroupLabel = mGroupKeyToLabel[sGroupKey];
        });

        oPostModel.setProperty("/allRows", aAllRows);
        oPostModel.setProperty(
            "/salesOrderGroupSummaryText",
            iNextGroupIndex === 0
                ? "No Sales Orders to post yet"
                : `This will post ${iNextGroupIndex} separate Sales Order${iNextGroupIndex === 1 ? "" : "s"}`
        );
    }

    /** True if sValue parses to a real, non-zero number (not "…" or "—"). */
    private _isNonZero(sValue: string): boolean {
        const fValue = parseFloat(sValue);
        return !isNaN(fValue) && fValue !== 0;
    }

    /**
     * A row counts as "Yes" only when Retro Billing Amount is a non-zero
     * number; "No" is everything else (zero, or still loading/not-found
     * and therefore not yet a confirmed non-zero number). Rate Difference
     * no longer factors in here - a row can have Rate Difference = 0 and
     * still count as "Yes" as long as its Retro Billing Amount isn't 0.
     * "All" matches everything.
     */
    private _matchesFilter(oRow: IPostCrDrRow, sFilterKey: TRetroBillingFilterKey): boolean {
        if (sFilterKey === "A") {
            return true;
        }
        const bRetroAmountNonZero = this._isNonZero(oRow.RetroBillingAmount);

        if (sFilterKey === "Y") {
            return bRetroAmountNonZero;
        }
        // "N": Retro Billing Amount is zero (or not-yet-numeric)
        return !bRetroAmountNonZero;
    }

    /**
     * Re-derives "/rows" (what the table binds to) from "/allRows" using
     * whatever "/showOnlyRetroBillingValue" is currently selected, and
     * updates "/visibleCountDisplayText" to a plain count of exactly what
     * ends up visible - it deliberately does NOT say "Yes:"/"No:"/"All:",
     * since the dropdown itself already tells the user which condition
     * that count belongs to.
     */
    private _applyRetroBillingValueFilter(oPostModel: JSONModel): void {
        const aAllRows = (oPostModel.getProperty("/allRows") as IPostCrDrRow[]) || [];
        const sFilterKey = (oPostModel.getProperty("/showOnlyRetroBillingValue") as TRetroBillingFilterKey) || "Y";

        const aFiltered = aAllRows
            .filter((oRow) => this._matchesFilter(oRow, sFilterKey))
            .sort((oA, oB) => oA.SalesOrderGroupIndex - oB.SalesOrderGroupIndex);

        oPostModel.setProperty("/rows", aFiltered);
        oPostModel.setProperty(
            "/visibleCountDisplayText",
            `${aFiltered.length} record${aFiltered.length === 1 ? "" : "s"}`
        );
    }
}