import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val signingPropertiesFile = rootProject.file("keystore.properties")
val signingProperties = Properties().apply {
    if (signingPropertiesFile.exists()) {
        signingPropertiesFile.inputStream().use { load(it) }
    }
}
val requestedSigningConfig = providers.gradleProperty("androidSigningConfig").orNull
val betaSigningStoreFile = providers.environmentVariable("ANDROID_BETA_RELEASE_KEYSTORE_PATH").orNull
val betaSigningStorePassword = providers.environmentVariable("ANDROID_BETA_RELEASE_KEYSTORE_PASSWORD").orNull
val betaSigningKeyAlias = providers.environmentVariable("ANDROID_BETA_RELEASE_KEY_ALIAS").orNull
val betaSigningKeyPassword = providers.environmentVariable("ANDROID_BETA_RELEASE_KEY_PASSWORD").orNull

if (requestedSigningConfig == "betaRelease") {
    require(!betaSigningStoreFile.isNullOrBlank()) { "Missing beta release keystore path." }
    require(rootProject.file(betaSigningStoreFile).isFile) { "Beta release keystore does not exist." }
    require(!betaSigningStorePassword.isNullOrBlank()) { "Missing beta release keystore password." }
    require(!betaSigningKeyAlias.isNullOrBlank()) { "Missing beta release key alias." }
    require(!betaSigningKeyPassword.isNullOrBlank()) { "Missing beta release key password." }
}

android {
    namespace = "io.freetubeapp.freetubeandroid"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = providers.gradleProperty("androidApplicationId")
            .orElse("io.freetubeapp.freetubeandroid")
            .get()
        minSdk = 29
        targetSdk = 36
        versionCode = providers.gradleProperty("androidVersionCode")
            .map(String::toInt)
            .orElse(1)
            .get()
        versionName = providers.gradleProperty("androidVersionName")
            .orElse("0.1.0-local")
            .get()
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("nightly") {
            if (signingPropertiesFile.exists()) {
                storeFile = file(signingProperties.getProperty("storeFile"))
                storePassword = signingProperties.getProperty("storePassword")
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("keyPassword")
            }
        }
        create("betaRelease") {
            if (requestedSigningConfig == "betaRelease") {
                storeFile = rootProject.file(betaSigningStoreFile!!)
                storePassword = betaSigningStorePassword
                keyAlias = betaSigningKeyAlias
                keyPassword = betaSigningKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            when (requestedSigningConfig) {
                "betaRelease" -> signingConfig = signingConfigs.getByName("betaRelease")
                "nightly" -> {
                    check(signingPropertiesFile.exists()) { "Missing android/keystore.properties for nightly signing." }
                    signingConfig = signingConfigs.getByName("nightly")
                }
                "none" -> Unit
                null -> if (signingPropertiesFile.exists()) {
                    signingConfig = signingConfigs.getByName("nightly")
                }
                else -> error("Unknown Android signing config: $requestedSigningConfig")
            }
        }
    }

    tasks.named("preBuild") {
        doFirst {
            val webBundle = file("src/main/assets/web.js")
            check(webBundle.exists()) {
                "Missing Android web bundle. Run pnpm run pack:android:core first."
            }

            val header = webBundle.inputStream().use { input ->
                input.readNBytes(4096).decodeToString()
            }
            check(!header.contains("eval-source-map")) {
                "Development web bundle detected. Run pnpm run pack:android:core instead."
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.github.TeamNewPipe:NewPipeExtractor:e8f89145a830b4d6cae32412007f24ea8b36c73a")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.2.0")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
