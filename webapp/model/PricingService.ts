/**
 * @namespace retrobillingapp.model
 *
 * Shared "New Rate / Rate Difference / Retro Billing Amount" logic.
 *
 * This used to live entirely inside retrobillingapp.controller.ts, wired up
 * to run for EVERY row loaded into screen 1's table. It has been pulled out
 * here, unchanged in behavior, because that logic is still needed - just
 * triggered differently: only for the F2 rows the user explicitly selects
 * on screen 1, fetched once on screen 2 (PostCrDr), instead of once per
 * visible row on screen 1.
 */

import ODataModel from "sap/ui/model/odata/v2/ODataModel";

export interface IConditionRateParams {
    Customer: string;
    ShipToParty: string;
    Plant: string;
    Material: string;
    SalesOrganization: string;
    BillingDate: string;
}

/** Returned while a rate lookup for a key is still in flight. */
export const RATE_LOADING = "…";
/** Returned when the pricing service found no matching condition record (or the call failed). */
export const RATE_NOT_FOUND = "—";

/**
 * Same day-resolution epoch used everywhere here, so a BillingDate coming
 * in as a JS Date, an ISO string, or an OData "/Date(...)/" string all
 * compare equal when they fall on the same calendar day (UTC).
 */
export function toDayEpoch(vDate: unknown): number {
    let oDate: Date | null = null;
    if (vDate instanceof Date) {
        oDate = vDate;
    } else if (typeof vDate === "string") {
        oDate = new Date(vDate);
    }
    if (!oDate || isNaN(oDate.getTime())) {
        return 0;
    }
    return Date.UTC(oDate.getUTCFullYear(), oDate.getUTCMonth(), oDate.getUTCDate());
}

export function odataDateToDayEpoch(sODataDate: string): number {
    const m = /\/Date\((-?\d+)/.exec(sODataDate || "");
    if (!m) {
        return 0;
    }
    return toDayEpoch(new Date(parseInt(m[1], 10)));
}

/** Condition type used for the "New Rate" lookup (unchanged from before). */
export const CONDITION_TYPE_RATE = "ZPR0";
/** Condition type used for the "New Discount Percent" lookup. */
export const CONDITION_TYPE_DISCOUNT = "Z007";

/**
 * Cache/dedup key for a pricing lookup - same shape callers used to build
 * inline, now with the ConditionType folded in so a "New Rate" (ZPR0)
 * lookup and a "New Discount Percent" (Z007) lookup for the very same
 * customer/ship-to/plant/material/sales-org/billing-date never collide in
 * a shared cache.
 */
export function buildKey(oParams: IConditionRateParams, sConditionType: string = CONDITION_TYPE_RATE): string {
    return [
        sConditionType,
        (oParams.Customer || "").trim(),
        (oParams.ShipToParty || "").trim(),
        (oParams.Plant || "").trim(),
        (oParams.Material || "").trim(),
        (oParams.SalesOrganization || "").trim(),
        toDayEpoch(oParams.BillingDate)
    ].join("|");
}

function buildFilterString(oParams: IConditionRateParams, sConditionType: string): string {
    const esc = (s: string) => (s || "").replace(/'/g, "''");

    if (sConditionType === CONDITION_TYPE_DISCOUNT) {
        // Z007's condition record (table 955) is only keyed on
        // SalesOrganization + Customer + Plant - it carries no Material
        // and no ShipToParty at all. Filtering on those extra fields (as
        // ZPR0's lookup does) always returns zero rows against a record
        // that has them blank, which is why New Discount Percent was
        // coming back not-found even though the record exists.
        return [
            `ConditionType eq '${esc(sConditionType)}'`,
            `Plant eq '${esc(oParams.Plant)}'`,
            `SalesOrganization eq '${esc(oParams.SalesOrganization)}'`,
            `Customer eq '${esc(oParams.Customer)}'`
        ].join(" and ");
    }

    return [
        `ConditionType eq '${esc(sConditionType)}'`,
        `Plant eq '${esc(oParams.Plant)}'`,
        `Material eq '${esc(oParams.Material)}'`,
        `SalesOrganization eq '${esc(oParams.SalesOrganization)}'`,
        `Customer eq '${esc(oParams.Customer)}'`,
        `ShipToParty eq '${esc(oParams.ShipToParty)}'`
    ].join(" and ");
}

/**
 * Calls A_SlsPrcgCndnRecdValidity ($expand=to_SlsPrcgConditionRecord so
 * ConditionRateValue comes back in the SAME call), picks the validity
 * period that covers BillingDate, and resolves with that
 * ConditionRateValue, or RATE_NOT_FOUND if nothing matches / the call
 * fails. Never rejects - callers don't need a .catch().
 *
 * IMPORTANT: oModel must be the "pricingConditionService" (or
 * "pricingModel") OData model already declared in manifest.json - e.g.
 * this.getOwnerComponent().getModel("pricingConditionService"). Building
 * the request off that model's own service URL (via getServiceUrl(),
 * instead of a hardcoded root-relative string) means the request always
 * resolves against whatever base path the app is actually deployed/
 * mounted under, so it keeps working after `cf deploy` regardless of the
 * app-router/HTML5 repo mount point.
 */
export function fetchConditionRate(
    oParams: IConditionRateParams,
    oModel: ODataModel,
    sConditionType: string = CONDITION_TYPE_RATE
): Promise<string> {
    const sServiceUrl = oModel.getServiceUrl().replace(/\/$/, "");
    const sUrl =
        `${sServiceUrl}/A_SlsPrcgCndnRecdValidity` +
        `?$filter=${encodeURIComponent(buildFilterString(oParams, sConditionType))}` +
        `&$expand=to_SlsPrcgConditionRecord` +
        `&$format=json`;

    // eslint-disable-next-line no-console
    console.log(`[Pricing:${sConditionType}] Fetching:`, sUrl);

    return fetch(sUrl, {
        method: "GET",
        headers: { "Accept": "application/json" },
        credentials: "include"
    })
        .then((oResponse) => {
            if (!oResponse.ok) {
                throw new Error(`HTTP ${oResponse.status} ${oResponse.statusText}`);
            }
            return oResponse.json();
        })
        .then((oJson: { d?: { results?: Array<Record<string, unknown>> } }) => {
            const aResults = oJson?.d?.results ?? [];

            const iBillingDay = toDayEpoch(oParams.BillingDate);

            const oMatch = aResults.find((r) => {
                const iStartDay = odataDateToDayEpoch(r.ConditionValidityStartDate as string);
                const iEndDay = odataDateToDayEpoch(r.ConditionValidityEndDate as string);
                return iBillingDay >= iStartDay && iBillingDay <= iEndDay;
            });

            const oConditionRecord = oMatch?.to_SlsPrcgConditionRecord as
                { ConditionRateValue?: string } | { __deferred?: unknown } | undefined;

            if (oMatch && oConditionRecord && "__deferred" in (oConditionRecord as object)) {
                // eslint-disable-next-line no-console
                console.error(`[Pricing:${sConditionType}] $expand did not take effect (still __deferred).`);
            }

            const sRate = (oConditionRecord as { ConditionRateValue?: string } | undefined)?.ConditionRateValue;
            return sRate !== undefined ? sRate : RATE_NOT_FOUND;
        })
        .catch((oError) => {
            // eslint-disable-next-line no-console
            console.error(`[Pricing:${sConditionType}] request failed:`, oError);
            return RATE_NOT_FOUND;
        });
}

/**
 * Rate Difference = New Rate - Original Rate.
 * sRate must be an actual numeric rate (not RATE_LOADING/RATE_NOT_FOUND) -
 * callers check that first, same as before.
 */
export function computeRateDifference(sRate: string, sOriginalRate: string): string {
    const fRate = parseFloat(sRate);
    const fOriginal = parseFloat(sOriginalRate) || 0;
    if (isNaN(fRate)) {
        return RATE_NOT_FOUND;
    }
    return (fRate - fOriginal).toFixed(2);
}

/** Retro Billing Amount = New Rate * Billing Quantity - ItemNetValueTotal. */
export function computeRetroBillingAmount(sRate: string, sBillingQuantity: string, sItemNetValueTotal: string): string {
    const fRate = parseFloat(sRate);
    const fQuantity = parseFloat(sBillingQuantity) || 0;
    const fItemNetValueTotal = parseFloat(sItemNetValueTotal) || 0;
    if (isNaN(fRate)) {
        return RATE_NOT_FOUND;
    }
    return (fRate * fQuantity - fItemNetValueTotal).toFixed(2);
}

/**
 * Retro Billing Amount, computed from an already-resolved New Amount
 * rather than re-deriving New Rate * Billing Quantity from scratch:
 *   Retro Billing Amount = New Amount - ItemNetValueTotal
 * Numerically identical to computeRetroBillingAmount() for F2 rows (where
 * New Amount is plain New Rate * Billing Quantity), but this is the
 * version PostCrDr.controller.ts's _recomputeRetroBillingAmount actually
 * calls, specifically so that CBRE's negated New Amount (see
 * negateAmount()) flows through into Retro Billing Amount instead of the
 * un-negated rate*qty being recalculated underneath it.
 */
export function computeRetroBillingAmountFromNewAmount(sNewAmount: string, sItemNetValueTotal: string): string {
    const fNewAmount = parseFloat(sNewAmount);
    const fItemNetValueTotal = parseFloat(sItemNetValueTotal) || 0;
    if (isNaN(fNewAmount) || sNewAmount === RATE_LOADING || sNewAmount === RATE_NOT_FOUND) {
        return RATE_NOT_FOUND;
    }
    return (fNewAmount - fItemNetValueTotal).toFixed(2);
}

/**
 * CBRE-only sign flip: for CBRE parents, New Amount (New Rate * Billing
 * Quantity) is posted/shown as the negative of the normal F2 calculation.
 * Only ever called on an already-resolved New Amount, so it only needs to
 * negate a plain numeric string. RATE_LOADING/RATE_NOT_FOUND aren't real
 * numbers, so they're passed through unchanged rather than turned into
 * "-NaN" - callers keep showing the same loading/not-found state either
 * way, just like every other derived column here.
 */
export function negateAmount(sAmount: string): string {
    const fAmount = parseFloat(sAmount);
    if (isNaN(fAmount) || sAmount === RATE_LOADING || sAmount === RATE_NOT_FOUND) {
        return sAmount;
    }
    return (-1 * fAmount).toFixed(2);
}

/**
 * New Amount = New Rate * Billing Quantity. Only meaningful once New Rate
 * has resolved to a real numeric value - same "not found if not
 * numeric" convention as the other derived columns here. Kept as its own
 * function (rather than inlined) since it's also the first half of
 * computeRetroBillingAmount's calculation, just without subtracting
 * ItemNetValueTotal.
 */
export function computeNewAmount(sRate: string, sBillingQuantity: string): string {
    const fRate = parseFloat(sRate);
    const fQuantity = parseFloat(sBillingQuantity) || 0;
    if (isNaN(fRate)) {
        return RATE_NOT_FOUND;
    }
    return (fRate * fQuantity).toFixed(2);
}

/**
 * Retro Billing Amount = (New Rate * Billing Quantity - ItemNetValueTotal)
 * - New Discount Amount. sBaseRetroBillingAmount is the pre-discount
 * figure from computeRetroBillingAmount() above; sNewDiscountAmount is
 * whatever's currently in the row's NewDiscountAmount column. A
 * not-found/non-numeric discount amount (e.g. no Z007 condition record
 * applies to this row) is treated as 0, i.e. no discount to subtract -
 * it does NOT block the Retro Billing Amount from finalizing. Callers
 * are responsible for not calling this while New Discount Percent is
 * still RATE_LOADING (see PostCrDr.controller.ts's
 * _recomputeRetroBillingAmount), so "not found" here unambiguously means
 * "resolved, no discount" rather than "still waiting".
 */
export function applyDiscountToRetroBillingAmount(sBaseRetroBillingAmount: string, sNewDiscountAmount: string): string {
    const fBase = parseFloat(sBaseRetroBillingAmount);
    if (isNaN(fBase)) {
        return RATE_NOT_FOUND;
    }
    const fDiscount = parseFloat(sNewDiscountAmount);
    const fDiscountSafe = isNaN(fDiscount) ? 0 : fDiscount;
    return (fBase + fDiscountSafe).toFixed(2);
}

/**
 * New Discount Amount = New Rate * Billing Quantity * (New Discount Percent / 100).
 * Needs BOTH sRate (New Rate, from the ZPR0 lookup) and sDiscountPercent
 * (New Discount Percent, from the Z007 lookup) to already be resolved,
 * actual numeric values - callers check that first (i.e. neither is still
 * RATE_LOADING/RATE_NOT_FOUND), same pattern as computeRateDifference /
 * computeRetroBillingAmount above.
 */
export function computeNewDiscountAmount(sRate: string, sBillingQuantity: string, sDiscountPercent: string): string {
    const fRate = parseFloat(sRate);
    const fQuantity = parseFloat(sBillingQuantity) || 0;
    const fDiscountPercent = parseFloat(sDiscountPercent);
    if (isNaN(fRate) || isNaN(fDiscountPercent)) {
        return RATE_NOT_FOUND;
    }
    return (fRate * fQuantity * (fDiscountPercent / 100)).toFixed(2);
}

/**
 * Final Retro Billing Amount = Retro Billing Amount
 *                              + (Retro Billing Amount * |New Discount Percent| / 100).
 *
 * sRetroBillingAmount is the already-calculated Retro Billing Amount (the
 * output of applyDiscountToRetroBillingAmount). The MAGNITUDE of the New
 * Discount Percent is applied to that figure and the result is ADDED to it.
 * Z007 comes back negative (e.g. -0.50), so the sign is deliberately
 * ignored (Math.abs) - otherwise adding a negative percent would reduce
 * the amount instead of increasing it.
 *
 * Example: 313.65 with New Discount Percent -0.50
 *          -> 313.65 + (313.65 * 0.50 / 100) = 315.21825
 *
 * The result is NOT rounded to 2 decimals (that would turn 315.21825 into
 * 315.22); it is only trimmed to 5 decimals to strip floating-point noise
 * such as 315.21825000000003. This is the value that gets POSTED; the
 * screen keeps showing the plain Retro Billing Amount.
 *
 * - If the Retro Billing Amount isn't a real number (loading / not found),
 *   the state is passed through unchanged, same convention as negateAmount().
 * - If New Discount Percent isn't numeric (no Z007 record found), it is
 *   treated as 0, so the Final amount equals the Retro Billing Amount.
 *   Callers must not call this while the discount lookup is still
 *   RATE_LOADING.
 */
export function computeFinalRetroBillingAmount(sRetroBillingAmount: string, sNewDiscountPercent: string): string {
    const fRetro = parseFloat(sRetroBillingAmount);
    if (isNaN(fRetro) || sRetroBillingAmount === RATE_LOADING || sRetroBillingAmount === RATE_NOT_FOUND) {
        return sRetroBillingAmount;
    }
    const fPercent = parseFloat(sNewDiscountPercent);
    const fPercentAbs = isNaN(fPercent) ? 0 : Math.abs(fPercent);
    const fFinal = fRetro + fRetro * (fPercentAbs / 100);
    return String(Number(fFinal.toFixed(5)));
}