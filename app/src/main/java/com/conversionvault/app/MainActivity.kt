package com.conversionvault.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.view.ViewGroup
import android.widget.FrameLayout
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.documentfile.provider.DocumentFile
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import com.conversionvault.app.bridge.AndroidBridge
import com.conversionvault.app.engine.ConversionForegroundService
import com.conversionvault.app.storage.VaultStorageManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var rootContainer: FrameLayout
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private var currentPickerMode: String = "single"
    private var webFileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val webChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        webFileChooserCallback?.onReceiveValue(uris)
        webFileChooserCallback = null
    }

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
        treeUri?.let { uri ->
            try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
            Thread {
                val tree = DocumentFile.fromTreeUri(this, uri)
                val arr = JSONArray()
                tree?.listFiles()?.forEach { doc ->
                    if (doc.isFile) {
                        val name = doc.name ?: "file"
                        arr.put(JSONObject().apply {
                            put("uri", doc.uri.toString())
                            put("name", name)
                            put("sizeBytes", doc.length())
                            put("folder", tree.name ?: "Folder")
                            put("path", VaultStorageManager.resolveInputPath(this@MainActivity, doc.uri.toString()))
                        })
                    }
                }
                val payload = JSONObject().apply {
                    put("mode", "folder")
                    put("treeUri", uri.toString())
                    put("folderName", tree?.name ?: "Selected Folder")
                    put("files", arr)
                }.toString()
                evalJs("window.onVaultFilesPicked && window.onVaultFilesPicked($payload);")
            }.start()
        }
    }

    private val notificationPermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> }

    private val progressReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ConversionForegroundService.ACTION_FINISH_APP) {
                finishAndRemoveTask()
                return
            }
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
        try {
            ContextCompat.startForegroundService(
                this,
                Intent(this, ConversionForegroundService::class.java).apply {
                    action = ConversionForegroundService.ACTION_START_SESSION
                }
            )
        } catch (_: Exception) {}

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    return assetLoader.shouldInterceptRequest(request.url)
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    webFileChooserCallback?.onReceiveValue(null)
                    webFileChooserCallback = filePathCallback
                    return try {
                        val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "*/*"
                        }
                        webChooserLauncher.launch(intent)
                        true
                    } catch (_: Exception) {
                        webFileChooserCallback = null
                        false
                    }
                }
            }
            addJavascriptInterface(AndroidBridge(this@MainActivity), "AndroidBridge")
        }

        rootContainer = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            addView(
                webView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )
        }
        setContentView(rootContainer)

        val extraGestureGapPx = (8 * resources.displayMetrics.density).toInt()
        ViewCompat.setOnApplyWindowInsetsListener(rootContainer) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom + extraGestureGapPx)
            insets
        }
        ViewCompat.requestApplyInsets(rootContainer)

        val savedTheme = getSharedPreferences("vault_settings", Context.MODE_PRIVATE)
            .getString("theme", "dark") ?: "dark"
        applySystemBarTheme(savedTheme)

        loadUiPage("conversion_vault_p1_home.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val curUrl = webView.url ?: ""
                if (curUrl.contains("p4a_convert_single.html") || curUrl.contains("p4_convert_batch.html")) {
                    loadUiPage("conversion_vault_p1_home.html")
                } else if (curUrl.contains("p1_home.html")) {
                    finish()
                } else if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    loadUiPage("conversion_vault_p1_home.html")
                }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        val filter = IntentFilter().apply {
            addAction(ConversionForegroundService.BROADCAST_PROGRESS)
            addAction(ConversionForegroundService.ACTION_FINISH_APP)
        }
        ContextCompat.registerReceiver(this, progressReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    override fun onPause() {
        super.onPause()
        try { unregisterReceiver(progressReceiver) } catch (_: Exception) {}
    }

    fun loadUiPage(filename: String) {
        val clean = filename.substringAfterLast('/')
        webView.loadUrl("https://appassets.androidplatform.net/assets/ui/$clean")
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
        val modeSnapshot = currentPickerMode
        Thread {
            val arr = JSONArray()
            uris.forEach { uri ->
                val resolved = VaultStorageManager.resolveInputPath(this@MainActivity, uri.toString())
                val f = File(resolved)
                arr.put(JSONObject().apply {
                    put("uri", uri.toString())
                    put("name", VaultStorageManager.getFileNameFromUri(this@MainActivity, uri))
                    put("path", resolved)
                    put("folder", f.parentFile?.name ?: "Storage")
                    put("sizeBytes", if (f.exists()) f.length() else 0L)
                })
            }
            val payload = JSONObject().apply {
                put("mode", modeSnapshot)
                put("files", arr)
            }.toString()
            evalJs("window.onVaultFilesPicked && window.onVaultFilesPicked($payload);")
        }.start()
    }

    fun applySystemBarTheme(theme: String) {
        val isLight = theme.equals("light", ignoreCase = true)
        val bgColor = Color.parseColor(if (isLight) "#FFFFFF" else "#070A10")
        if (::rootContainer.isInitialized) {
            rootContainer.setBackgroundColor(bgColor)
        }
        @Suppress("DEPRECATION")
        window.statusBarColor = bgColor
        @Suppress("DEPRECATION")
        window.navigationBarColor = bgColor
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = isLight
        controller.isAppearanceLightNavigationBars = isLight
    }

    fun evalJsFromBridge(script: String) { evalJs(script) }

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
