plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "xyz.kurohane.streamdrop"
    compileSdk = 35
    defaultConfig {
        applicationId = "xyz.kurohane.streamdrop"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.0.1-spike"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // A third-party build of libwebrtc: pinned, and to be kept up to date for security fixes.
    implementation("io.github.webrtc-sdk:android:150.7871.04")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
