import java.util.Properties
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing. `keystore.properties` is written by CI from the
// ANDROID_KEYSTORE_* secrets (and is gitignored); when it is absent the
// release build falls back to the debug key so a local `bun tauri android
// build` still produces an installable artifact.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 37
    namespace = "pro.kawai.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "pro.kawai.app"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            keystoreProperties.getProperty("storeFile")?.let {
                storeFile = file(it)
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            signingConfig =
                if (keystoreProperties.getProperty("storeFile") != null) {
                    signingConfigs.getByName("release")
                } else {
                    signingConfigs.getByName("debug")
                }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))

// ── Release native-library stripping ───────────────────────────────────────
// An APK stores native libraries uncompressed (extractNativeLibs=false), so
// every byte of the Rust .so's .symtab counts against the download size —
// ~64 MB on the arm64 library alone. AGP's strip<Variant>DebugSymbols task
// passes prebuilt jniLibs through untouched, so release builds strip here:
// `llvm-strip --strip-unneeded` drops .symtab while preserving .dynsym, which
// keeps JNI entrypoints, dlopen and DT_NEEDED resolution intact. Unstripped
// copies are exported to build/outputs/native-debug-symbols/lib/<abi>/ for
// Play Console's native debug symbols upload (crash symbolication).
abstract class StripReleaseNativeLibs : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val jniLibs: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val symbolsDir: DirectoryProperty

    @get:Input
    abstract val llvmStrip: Property<String>

    @TaskAction
    fun strip() {
        val symbols = symbolsDir.get().asFile
        val strip = File(llvmStrip.get())
        if (!strip.canExecute()) {
            logger.warn("kawai: llvm-strip not found (${strip.path}) — release native libraries stay unstripped")
            return
        }
        val libs = jniLibs.files
            .filter { it.isFile && it.name.endsWith(".so") }
            .sortedBy { it.path }
        if (libs.isEmpty()) return

        // Strip a copy-then-compare pass: a library that is already stripped
        // shrinks no further, so its (already stripped) bytes are never
        // exported as debug symbols. This keeps the exported set valid when
        // the same jniLibs directory is packaged twice (AAB then APK).
        data class Staged(val lib: File, val unstripped: File, val shrunk: Boolean)

        val staged = libs.map { lib ->
            val abi = lib.parentFile.name
            val original = File(temporaryDir, "$abi-${lib.name}")
            lib.copyTo(original, overwrite = true)
            val proc = ProcessBuilder(strip.path, "--strip-unneeded", lib.absolutePath)
                .redirectErrorStream(true)
                .start()
            val output = proc.inputStream.bufferedReader().use { it.readText() }.trim()
            if (proc.waitFor() != 0) {
                throw GradleException("llvm-strip failed on $abi/${lib.name}: $output")
            }
            logger.lifecycle(
                "kawai: stripped $abi/${lib.name} ${original.length() / 1_048_576} MB → ${lib.length() / 1_048_576} MB"
            )
            // A real .symtab is megabytes; a few bytes of section-header
            // normalisation is not a symbol table (prebuilt engine libs are
            // already stripped), so it must not trigger an export.
            Staged(lib, original, original.length() - lib.length() > 4096)
        }

        if (staged.none { it.shrunk }) {
            logger.lifecycle("kawai: release native libraries were already stripped — keeping the existing debug symbols")
            return
        }
        symbols.deleteRecursively()
        symbols.mkdirs()
        for (entry in staged.filter { it.shrunk }) {
            val abi = entry.lib.parentFile.name
            val debugCopy = symbols.resolve("lib/$abi/${entry.lib.name}")
            debugCopy.parentFile.mkdirs()
            entry.unstripped.copyTo(debugCopy, overwrite = true)
        }
    }
}

fun resolveLlvmStrip(): String {
    val os = System.getProperty("os.name").lowercase()
    val hostPrefix = when {
        os.contains("mac") -> "darwin"
        os.contains("win") -> "windows"
        else -> "linux"
    }
    val ndks = mutableListOf<File>()
    for (key in listOf("ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_HOME")) {
        System.getenv(key)?.takeIf { it.isNotBlank() }?.let { ndks.add(File(it)) }
    }
    val sdkRoots = listOf("ANDROID_HOME", "ANDROID_SDK_ROOT")
        .mapNotNull { System.getenv(it)?.takeIf { v -> v.isNotBlank() } }
        .map { File(it) } + listOf(
        File(System.getProperty("user.home"), "Library/Android/sdk"),
        File(System.getProperty("user.home"), "Android/Sdk"),
    )
    for (sdk in sdkRoots) {
        sdk.resolve("ndk").listFiles()?.let { ndks.addAll(it) }
    }
    return ndks
        .filter { it.isDirectory }
        .sortedByDescending { it.name }
        .asSequence()
        .mapNotNull { it.resolve("toolchains/llvm/prebuilt").listFiles()?.asSequence() }
        .flatten()
        .filter { it.name.startsWith(hostPrefix) }
        .map { it.resolve("bin/llvm-strip") }
        .firstOrNull { it.canExecute() }
        ?.absolutePath
        ?: "llvm-strip"
}

val stripReleaseNativeLibs = tasks.register<StripReleaseNativeLibs>("stripReleaseNativeLibs") {
    group = "build"
    description = "Strips release .so files and exports native debug symbols for Play"
    jniLibs.from(fileTree(layout.projectDirectory.dir("src/main/jniLibs")))
    symbolsDir.set(layout.buildDirectory.dir("outputs/native-debug-symbols"))
    llvmStrip.set(resolveLlvmStrip())
    outputs.upToDateWhen { false }
}

// Hook the merge that feeds packaging (after Tauri has populated jniLibs with
// the Rust .so), so both the AAB and the APK variant pick up the stripped libs.
tasks.matching {
    it.name.startsWith("merge") && it.name.endsWith("JniLibFolders") && it.name.contains("Release")
}.configureEach {
    dependsOn(stripReleaseNativeLibs)
}

// Tauri's rust build populates jniLibs (including the libc++_shared.so
// symlink); Gradle runs dependencies in arbitrary order, so without this pin
// the strip task can execute against an empty jniLibs dir and silently strip
// nothing. Force the strip to run AFTER the Rust build.
stripReleaseNativeLibs.configure {
    dependsOn(tasks.matching { it.name.startsWith("rustBuild") })
}
