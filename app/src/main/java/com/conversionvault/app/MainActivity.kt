package com.conversionvault.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.conversionvault.app.bridge.AndroidBridge
import com.conversionvault.app.engine.ConversionForegroundService
import com.conversionvault.app.storage.VaultStorageManager
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var currentPickerMode: String = "single"

    private val singleFileLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        uri?.let {
            try { contentResolver.takePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
            dispatchPickedFiles(listOf(it))
        }
    }

    private val multiFileLauncher = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris: List<Uri> ->
        if (uris.isNotEmpty()) {
            uris.forEach {
                try { contentResolver.takePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
            }
            dispatchPickedFiles(uris)
        }
    }

    private val folderLauncher = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { treeUri: Uri? ->
        treeUri?.let {
            try { contentResolver.takePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
            val payload = JSONObject().apply {
                put("mode", "folder")
                put("treeUri", it.toString())
            }.toString()
            evalJs("window.onVaultFilesPicked && window.onVaultFilesPicked($payload);")
        }
    }

    private val notificationPermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> }

    private val progressReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val json = intent?.getStringExtra(ConversionForegroundService.EXTRA_EVENT_JSON) ?: return
            evalJs("window.onVaultEvent && window.onVaultEvent($json);")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        VaultStorageManager.ensureVaultFolders(this)
        VaultStorageManager.cleanupExpiredSamples(this, 15)
        VaultStorageManager.scheduleSampleCleanup(this)

        requestRequiredPermissions()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowFileAccessFromFileURLs = true
            settings.allowUniversalAccessFromFileURLs = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
            addJavascriptInterface(AndroidBridge(this@MainActivity), "AndroidBridge")
        }
        setContentView(webView)
        loadUiPage("conversion_vault_p1_home.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    override fun onResume() {
        super.onResume()
        val filter = IntentFilter(ConversionForegroundService.BROADCAST_PROGRESS)
        ContextCompat.registerReceiver(this, progressReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    override fun onPause() {
        super.onPause()
        try { unregisterReceiver(progressReceiver) } catch (_: Exception) {}
    }

    fun loadUiPage(filename: String) {
        val clean = filename.substringAfterLast('/')
        webView.loadUrl("file:///android_asset/ui/$clean")
    }

    fun launchPicker(mode: String, mimeFilter: String) {
        currentPickerMode = mode
        val mime = if (mimeFilter.isBlank()) "*/*" else mimeFilter
        when (mode) {
            "folder" -> folderLauncher.launch(null)
            "multi" -> multiFileLauncher.launch(arrayOf(mime))
            else -> singleFileLauncher.launch(arrayOf(mime))
        }
    }

    private fun dispatchPickedFiles(uris: List<Uri>) {
        val arr = JSONArray()
        uris.forEach { uri ->
            arr.put(JSONObject().apply {
                put("uri", uri.toString())
                put("name", VaultStorageManager.getFileNameFromUri(this@MainActivity, uri))
                put("path", VaultStorageManager.resolveInputPath(this@MainActivity, uri.toString()))
            })
        }
        val payload = JSONObject().apply {
            put("mode", currentPickerMode)
            put("files", arr)
        }.toString()
        evalJs("window.onVaultFilesPicked && window.onVaultFilesPicked($payload);")
    }

    private fun evalJs(script: String) {
        webView.post { webView.evaluateJavascript(script, null) }
    }

    private fun requestRequiredPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                notificationPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
            try {
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            } catch (_: Exception) {}
        }
    }
}
