// The Kotlin client for gemi agents: `useChat` for Android.
//
//   gemi-chat          the client itself, plain JVM: models, the SSE decoder,
//                      the reducer, `ChatSession`. Usable from any Kotlin app.
//   gemi-chat-compose  `rememberChat`, the thin Jetpack Compose wrapper.
//
// Kept apart so the core's tests run on a JVM without an Android toolchain,
// and so an app that is not written in Compose does not depend on it.

pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "gemi-kotlin"

include(":gemi-chat")

// The Compose module needs an Android SDK. Left out where there is none, so
// the core still builds and tests anywhere a JDK does — and where the module
// itself is not there, which Gradle refuses to configure.
if (
  file("gemi-chat-compose").isDirectory &&
    (System.getenv("ANDROID_HOME") != null ||
      file("local.properties").let { it.exists() && it.readText().contains("sdk.dir") })
) {
  include(":gemi-chat-compose")
}
