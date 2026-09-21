plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.compose)
}

android {
  namespace = "dev.gemijs.chat.compose"
  // 35, not higher, so an app need not raise its own: OkHttp 5.4 and later
  // demand 37 of everything that depends on them, which is why the core pins
  // 5.3 as its floor. An app on a newer OkHttp resolves to that one.
  compileSdk = 35
  // 26 for `java.time`, which `gemi-chat` timestamps optimistic messages with.
  defaultConfig { minSdk = 26 }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin {
  jvmToolchain(17)
  explicitApi()
}

dependencies {
  api(project(":gemi-chat"))
  implementation(platform(libs.compose.bom))
  implementation(libs.compose.runtime)
}
