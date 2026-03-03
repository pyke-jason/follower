plugins {
    java
    application
}

group = "com.tradefollower"
version = "1.0.0"

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

repositories {
    mavenCentral()
}

dependencies {
    // Javalin HTTP server
    implementation("io.javalin:javalin:6.4.0")

    // Jackson JSON
    implementation("com.fasterxml.jackson.core:jackson-databind:2.18.2")

    // SLF4J + Logback
    implementation("org.slf4j:slf4j-api:2.0.16")
    implementation("ch.qos.logback:logback-classic:1.5.15")

    // TwsApi.jar — local dependency (download from IBKR, place in lib/)
    implementation(files("lib/TwsApi.jar"))

    // Protobuf — required by TWS API 10.40+
    implementation("com.google.protobuf:protobuf-java:4.29.3")
}

application {
    mainClass.set("com.tradefollower.sidecar.App")
}

tasks.jar {
    manifest {
        attributes["Main-Class"] = "com.tradefollower.sidecar.App"
    }

    // Build fat jar with all dependencies
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) })
}
