package com.tradefollower.sidecar;

import java.util.Set;

/**
 * Typed exception carrying a TWS API error code.
 * Thrown by TwsBridge.error() to let route handlers classify errors by code
 * rather than fragile string matching.
 */
public class TwsException extends RuntimeException {

    // 354: Not subscribed, 10089/10090/10091: market data subscription required,
    // 10186: delayed not enabled, 10197: competing live session.
    private static final Set<Integer> NO_MARKET_DATA_CODES = Set.of(354, 10089, 10090, 10091, 10186, 10197);

    private final int errorCode;

    public TwsException(int errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public int getErrorCode() {
        return errorCode;
    }

    /** TWS error 200: No security definition found (invalid symbol, strike, expiry, etc.) */
    public boolean isNoSecurityDef() {
        return errorCode == 200;
    }

    /** TWS error 321: Invalid request (missing fields, bad format) */
    public boolean isValidationError() {
        return errorCode == 321;
    }

    /** TWS error 201: Order rejected (insufficient margin, risk rules, etc.) */
    public boolean isOrderRejected() {
        return errorCode == 201;
    }

    /** Market-data subscription missing — requires human intervention at IBKR. */
    public boolean isNoMarketData() {
        return NO_MARKET_DATA_CODES.contains(errorCode);
    }
}
