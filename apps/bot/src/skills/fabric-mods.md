# Fabric mod skill

Use this when building, patching or debugging a Fabric mod for Minecraft Java Edition.

## Project layout
- `build.gradle` applies `net.fabricmc.fabric-loom` (the Loom plugin) and `maven-publish`.
- `gradle.properties` holds `minecraft_version`, `yarn_mappings`, `loader_version`, `fabric_version` (Fabric API), and `mod_version`.
- `src/main/resources/fabric.mod.json` declares the mod id, version, entrypoints (`main`, `client`, `server`), mixins and dependencies (`fabricloader`, `minecraft`, `java`, `fabric-api`).
- `src/main/java/<pkg>/` has the `ModInitializer` (server/common) and optional `ClientModInitializer`.
- `src/main/resources/<modid>.mixins.json` lists mixin classes, if any.

## Build and run
- Build: `./gradlew build`. Output jar is in `build/libs/`.
- Dev client: `./gradlew runClient`. Dev server: `./gradlew runServer`.
- Use Java 21 for current 1.20.5+ versions. Check the version table in the Fabric docs for the matching Java version.
- Recommended Fabric Loom version: `1.18-SNAPSHOT`, usually set in the `plugins` block of `build.gradle` as `id 'fabric-loom' version '1.18-SNAPSHOT'`. Source: https://fabricmc.net/develop/.
- Reference: the official template https://github.com/FabricMC/fabric-example-mod — for current 1.21.x versions, its `gradle.properties` is the reference.

## Code rules
- Register content in `onInitialize()` using the Registry API, with `Identifier` ids under your mod id.
- Client-only code (rendering, keybinds, screens) goes in `ClientModInitializer`, never in the common entrypoint.
- Mixins: keep them minimal, use `@Inject` with explicit `at =` targets, and check target names against the Yarn mappings for the pinned version.
- Depend on Fabric API for hooks like events (`ServerLifecycleEvents`, `ServerTickEvents`) instead of mixing into vanilla when an event exists.

## Mappings
- Yarn names are the default in source. Look them up on the Fabric maven or the Yarn tiny files for the exact `yarn_mappings` build.
- Mixin target descriptors break silently across versions, so re-check them whenever `minecraft_version` changes.

## Debugging
- Crash on launch with `NoSuchMethodError` or `AbstractMethodError`: the mappings or the Fabric API version don't match `minecraft_version`.
- Mixin failures show `InvalidInjectionException` in the log with the failing target. Fix the target name first.
- Check `fabric.mod.json` for typos first: a bad entrypoint class name fails at load time.

## Not covered
- Quilt, NeoForge and Forge (use the Forge skill for legacy Forge).
- Verified against a live build: no. Confirm the pinned versions on fabricmc.net before relying on them.
