package dev.futurejarvis.agent;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;

/** Small native shell; bundled assets only, no native JS interface or filesystem access.
 * Node, Git and providers run on the host. USB reverse maps device loopback to host.
 */
public final class MainActivity extends Activity {
    private WebView web;
    private static final String HOST = "appassets.androidplatform.net";
    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(17, 20, 24));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // Non-secret preferences only.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        // HTTPS bundled assets need loopback HTTP for adb reverse. Network security
        // config blocks cleartext to all other hosts; CSP limits connections too.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        WebView.setWebContentsDebuggingEnabled(false);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isAsset(request.getUrl());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!HOST.equals(uri.getHost())) return null;
                if (!isAsset(uri)) return missing();
                String rel = uri.getPath().substring("/assets/".length());
                if (rel.isEmpty() || rel.contains("..") || rel.contains("\\")) return missing();
                String mime = rel.endsWith(".html") ? "text/html" : rel.endsWith(".js") ? "text/javascript" : rel.endsWith(".css") ? "text/css" : rel.endsWith(".svg") ? "image/svg+xml" : "application/json";
                try { return new WebResourceResponse(mime, "UTF-8", getAssets().open(rel)); }
                catch (IOException e) { return missing(); }
            }
        });
        setContentView(web);
        if (Build.VERSION.SDK_INT >= 30) {
            web.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return insets;
            });
        }
        web.loadUrl("https://" + HOST + "/assets/index.html");
    }
    private static boolean isAsset(Uri uri) {
        return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && uri.getPath() != null && uri.getPath().startsWith("/assets/");
    }
    private static WebResourceResponse missing() {
        WebResourceResponse result = new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
        result.setStatusCodeAndReasonPhrase(404, "Not Found"); return result;
    }
    @Override protected void onDestroy() {
        if (web != null) { web.loadUrl("about:blank"); web.destroy(); }
        super.onDestroy();
    }
}
