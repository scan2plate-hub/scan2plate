package com.scan2plate.restaurantpos;

import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Switches the app's single WebView between the live remote site
 * (capacitor.config.json's server.url) and the offline-billing page bundled
 * into the APK (mobile/www/offline-billing.html, served from the app's own
 * local asset origin) - the equivalent, for Android, of the desktop app's
 * "Continue Billing Offline" window switch (desktop/main.js's
 * showOfflineBillingMode()).
 *
 * This has to be a native plugin rather than plain JS navigation because
 * the live site and the bundled page are different WebView origins
 * (https://scan2plate.com vs. Capacitor's local asset origin) - a page
 * can't navigate itself across that boundary via window.location, but the
 * native WebView object can be told to load either URL directly.
 *
 * The bundled page is loaded via Capacitor's own local-server origin
 * (https://localhost/..., the default hostname/scheme - see
 * com.getcapacitor.CapConfig's "localhost" default and Bridge's
 * shouldInterceptRequest, which always routes through
 * bridge.getLocalServer() regardless of which URL is current) rather than a
 * raw file:// path, specifically so Capacitor's JS bridge
 * (window.Capacitor / Capacitor.Plugins.*, needed by offline-db.js to reach
 * the SQLite plugin) is actually injected into it - a raw file:// load
 * bypasses that local-server interception and would leave the page with no
 * bridge at all.
 */
@CapacitorPlugin(name = "OfflineNav")
public class OfflineNavPlugin extends Plugin {

    private static final String OFFLINE_BILLING_URL = "https://localhost/offline-billing.html";
    private static final String LIVE_SITE_URL = "https://scan2plate.com/admin-login.html";

    @PluginMethod
    public void goOffline(PluginCall call) {
        WebView webView = getBridge().getWebView();
        if (webView == null) {
            call.reject("WebView is not available");
            return;
        }
        getActivity().runOnUiThread(() -> webView.loadUrl(OFFLINE_BILLING_URL));
        call.resolve();
    }

    @PluginMethod
    public void returnOnline(PluginCall call) {
        WebView webView = getBridge().getWebView();
        if (webView == null) {
            call.reject("WebView is not available");
            return;
        }
        getActivity().runOnUiThread(() -> webView.loadUrl(LIVE_SITE_URL));
        call.resolve();
    }

    @PluginMethod
    public void isOnOfflinePage(PluginCall call) {
        WebView webView = getBridge().getWebView();
        String currentUrl = webView != null ? webView.getUrl() : null;
        JSObject result = new JSObject();
        result.put("value", currentUrl != null && currentUrl.startsWith("https://localhost/"));
        call.resolve(result);
    }
}
