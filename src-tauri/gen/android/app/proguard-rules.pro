# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# rustls-platform-verifier (reqwest TLS on Android): CertificateVerifier is
# instantiated from Rust via JNI BY NAME — invisible to R8, which strips it
# from release builds. Without this rule every HTTPS call dies with
# "error sending request" (auth login, JWKS, remote LLM, Loki push).
# Debug builds don't minify, which is why only release was broken.
-keep class org.rustls.platformverifier.** { *; }
# KawaiHeadless (detached scrape WebView): driven from Rust over JNI by class
# and method name (find_class("pro/kawai/app/KawaiHeadless") → start/poll), so
# R8 cannot see the references and strips the class from release builds —
# every scrape would then fall back to Cloudflare. Debug builds don't minify,
# which is why only release breaks.
-keep class pro.kawai.app.KawaiHeadless { *; }
# KawaiForeground (run foreground service): started from Rust over JNI by class
# and method name (load_class("pro/kawai/app/KawaiForeground") → start/stop).
# Stripped from release builds it would leave every long run unprotected from
# the cached-app freezer — a failure that only shows up after the app is
# backgrounded mid-generation.
-keep class pro.kawai.app.KawaiForeground { *; }
