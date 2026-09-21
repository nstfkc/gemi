plugins {
  alias(libs.plugins.kotlin.jvm)
  alias(libs.plugins.kotlin.serialization)
  `java-library`
}

group = "dev.gemijs"

kotlin {
  jvmToolchain(17)
  explicitApi()
}

dependencies {
  api(libs.serialization.json)
  api(libs.coroutines.core)
  implementation(libs.okhttp)

  testImplementation(kotlin("test"))
  testImplementation(libs.coroutines.test)
}

tasks.test {
  useJUnitPlatform()
  // The end-to-end tests run against `packages/gemi-swift/e2e/server.ts` when
  // this names it, and skip otherwise.
  environment("GEMI_E2E_URL", System.getenv("GEMI_E2E_URL") ?: "")
  testLogging {
    events("failed")
    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
  }
}
