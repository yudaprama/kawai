buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
        // org.rustls:rustls-platform-verifier — the JNI TLS-verifier component
        // that rustls-platform-verifier drives from Rust (see lib.rs setup).
        // Distributed only through this GitHub-hosted Maven archive.
        maven { url = uri("https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/") }
    }
}

tasks.register("clean").configure {
    delete("build")
}

