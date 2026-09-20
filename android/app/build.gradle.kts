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
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            if (signingPropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("nightly")
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
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.2.0")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
