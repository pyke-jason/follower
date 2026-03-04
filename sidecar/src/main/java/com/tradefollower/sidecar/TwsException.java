package com.tradefollower.sidecar;

/**
 * Typed exception carrying a TWS API error code.
 * Thrown by TwsBridge.error() to let route handlers classify errors by code
 * rather than fragile string matching.
 */
public class TwsException extends RuntimeException {

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
}
