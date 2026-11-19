plugins {
  alias(libs.plugins.kotlin.jvm)
  `java-library`
}

group = "dev.gemijs"

kotlin {
  jvmToolchain(17)
  explicitApi()
}

dependencies {
  api(libs.serialization.json)
  implementation(libs.coroutines.core)
  api(libs.okhttp)
}
