package com.tradefollower.sidecar;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Jackson-deserialized request bodies for all POST/PUT endpoints.
 * Required fields use @JsonProperty(required = true) — Jackson throws
 * MismatchedInputException (→ global 400) if missing.
 * Optional fields get defaults applied in the constructor.
 */
final class RequestBodies {

    private RequestBodies() {}

    /** POST /api/orders/single */
    record PlaceSingleBody(
        int conId,
        String action,
        long quantity,
        String orderType,
        String tif,
        Double limitPrice,
        Double auxPrice,
        String clientOrderRef
    ) {
        @JsonCreator
        PlaceSingleBody(
            @JsonProperty(value = "conId", required = true) int conId,
            @JsonProperty(value = "action", required = true) String action,
            @JsonProperty(value = "quantity", required = true) long quantity,
            @JsonProperty("orderType") String orderType,
            @JsonProperty("tif") String tif,
            @JsonProperty("limitPrice") Double limitPrice,
            @JsonProperty("auxPrice") Double auxPrice,
            @JsonProperty("clientOrderRef") String clientOrderRef
        ) {
            this.conId = conId;
            this.action = action;
            this.quantity = quantity;
            this.orderType = orderType != null ? orderType : "LMT";
            this.tif = tif != null ? tif : "GTC";
            this.limitPrice = limitPrice;
            this.auxPrice = auxPrice;
            this.clientOrderRef = clientOrderRef;
        }
    }

    /** Nested leg definition for combo orders */
    record ComboLegBody(
        int conId,
        String action,
        int ratio,
        String exchange
    ) {
        @JsonCreator
        ComboLegBody(
            @JsonProperty(value = "conId", required = true) int conId,
            @JsonProperty(value = "action", required = true) String action,
            @JsonProperty("ratio") Integer ratio,
            @JsonProperty("exchange") String exchange
        ) {
            this(conId, action, ratio != null ? ratio : 1, exchange != null ? exchange : "SMART");
        }
    }

    /** POST /api/orders/combo */
    record PlaceComboBody(
        String symbol,
        String action,
        long quantity,
        List<ComboLegBody> legs,
        String orderType,
        String tif,
        Double limitPrice,
        String clientOrderRef
    ) {
        @JsonCreator
        PlaceComboBody(
            @JsonProperty(value = "symbol", required = true) String symbol,
            @JsonProperty(value = "action", required = true) String action,
            @JsonProperty(value = "quantity", required = true) long quantity,
            @JsonProperty(value = "legs", required = true) List<ComboLegBody> legs,
            @JsonProperty("orderType") String orderType,
            @JsonProperty("tif") String tif,
            @JsonProperty("limitPrice") Double limitPrice,
            @JsonProperty("clientOrderRef") String clientOrderRef
        ) {
            this.symbol = symbol;
            this.action = action;
            this.quantity = quantity;
            this.legs = legs;
            this.orderType = orderType != null ? orderType : "LMT";
            this.tif = tif != null ? tif : "GTC";
            this.limitPrice = limitPrice;
            this.clientOrderRef = clientOrderRef;
        }
    }

    /** PUT /api/orders/{orderId} */
    record ModifyBody(
        @JsonProperty(value = "limitPrice", required = true) double limitPrice
    ) {}

    /** POST /api/contracts/resolve */
    record ResolveContractBody(
        @JsonProperty String symbol,
        @JsonProperty String secType,
        @JsonProperty String expiry,
        @JsonProperty Double strike,
        @JsonProperty String right,
        @JsonProperty String exchange,
        @JsonProperty String currency
    ) {
        String symbolOrDefault() { return symbol != null ? symbol : ""; }
        String secTypeOrDefault() { return secType != null ? secType : "STK"; }
        String exchangeOrDefault() { return exchange != null ? exchange : "SMART"; }
        String currencyOrDefault() { return currency != null ? currency : "USD"; }
    }

    /** POST /api/market-data/snapshot */
    record SnapshotBody(
        @JsonProperty Integer conId,
        @JsonProperty String symbol,
        @JsonProperty String secType,
        @JsonProperty String expiry,
        @JsonProperty Double strike,
        @JsonProperty String right,
        @JsonProperty String exchange,
        @JsonProperty String currency
    ) {
        String symbolOrDefault() { return symbol != null ? symbol : ""; }
        String secTypeOrDefault(String fallback) { return secType != null ? secType : fallback; }
        String exchangeOrDefault() { return exchange != null ? exchange : "SMART"; }
        String currencyOrDefault() { return currency != null ? currency : "USD"; }
    }
}
