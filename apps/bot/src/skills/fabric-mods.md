---
name: fabric-mods
description: Build, port or debug a Fabric mod for Minecraft Java Edition (1.14 to 26.x) in the sandbox: the right Loom plugin, mappings and Java for the version, current versions from Fabric's meta API, mixins, fabric.mod.json, crash logs. Use whenever a Fabric mod jar is being made or fixed, or a Fabric crash log needs reading.
---

# Fabric mods

Someone restarts their game for every jar you hand them. Most broken Fabric builds come from versions remembered instead of looked up: Fabric changed the build setup completely at Minecraft 26.1. **Look every version up from Fabric's meta API before writing `gradle.properties`.**

## 1. Which setup the Minecraft version needs

Minecraft versions are `1.21.x` up to 1.21.11, then year-based (`26.1`, `26.2`, `26.3`, …). From 26.1 Mojang ships the game **unobfuscated**, so there are no mappings at all.

| | 26.1 and newer | 1.21.11 and older |
|---|---|---|
| Loom plugin | `id 'net.fabricmc.fabric-loom' version "${loom_version}"` | `id 'net.fabricmc.fabric-loom-remap' version "${loom_version}"` |
| Mappings | none. No `mappings` line, no `yarn_mappings` | `mappings "net.fabricmc:yarn:${project.yarn_mappings}:v2"` (or `loom.officialMojangMappings()`) |
| Dependency config | `implementation` (loader, Fabric API, other mods) | `modImplementation` |
| Names in source | Mojang's real names | Yarn names (or Mojang's, with officialMojangMappings) |
| Java | 25 | 21 for 1.20.5+, 17 for 1.18–1.20.4, 16 for 1.17, 8 for 1.16 and older |

The old plugin id `fabric-loom` and Yarn on a 26.x version are the two commonest mistakes. Set `options.release` and `sourceCompatibility`/`targetCompatibility` to the Java above, and `"java": ">=<that>"` in `fabric.mod.json`.

## 2. Current versions: look them up, never remember them

```bash
curl -s https://meta.fabricmc.net/v2/versions/game | jq -r '[.[]|select(.stable)][0].version'     # latest stable Minecraft
curl -s https://meta.fabricmc.net/v2/versions/loader | jq -r '[.[]|select(.stable)][0].version'   # loader_version
curl -s https://meta.fabricmc.net/v2/versions/yarn/1.21.11 | jq -r '.[0].version'                  # yarn_mappings (empty on 26.x)
curl -s https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml \
  | grep -o '<version>[^<]*+1.21.11</version>' | tail -1                                            # fabric_api_version for that Minecraft
```

Loom: `loom_version=1.18-SNAPSHOT` is what fabricmc.net/develop and the template recommend today. Check the template if in doubt. The template is https://github.com/FabricMC/fabric-example-mod, generated from fabricmc.net/develop for the latest stable version. Copy its `build.gradle`, `settings.gradle`, `gradle.properties` and Gradle wrapper rather than writing them by hand, then apply the table above for an older version. It uses split source sets: common code in `src/main`, client-only code in `src/client`, wired up by `loom { splitEnvironmentSourceSets() }`.

## 3. Toolchain and build in the sandbox (no root, ~1 GB RAM)

```bash
mkdir -p ~/jvm && cd ~/jvm
J=25   # the Java from the table
[ -x ~/jvm/jdk$J/bin/javac ] || { curl -sfL -o jdk.tgz "https://api.adoptium.net/v3/binary/latest/$J/ga/linux/x64/jdk/hotspot/normal/eclipse" && mkdir jdk$J && tar xzf jdk.tgz -C jdk$J --strip-components=1 && rm jdk.tgz; }
export JAVA_HOME=~/jvm/jdk$J PATH=~/jvm/jdk$J/bin:$PATH
```

- Build with `./gradlew build --no-daemon`. The jar is in `build/libs/` (skip `-sources.jar`). The first build downloads Minecraft and sets it up, which takes minutes. Run it detached and poll instead of letting a command time out.
- The template's `org.gradle.jvmargs=-Xmx1G` is the whole sandbox. Lower it to `-Xmx640m` if Gradle gets killed.
- `runClient` needs a display and a GPU, so it can't prove anything here. `runServer` can boot a dedicated server to show common code and mixins load. Accept the EULA in `run/eula.txt` first, and stop it once `Done (` appears.

## 4. Code facts

- `fabric.mod.json`: `entrypoints.main` takes a `ModInitializer`, `entrypoints.client` a `ClientModInitializer` (from `src/client`). A client-only mixin config goes in `mixins` as `{ "config": "<modid>.client.mixins.json", "environment": "client" }`. A wrong class name here fails at load, so check it first.
- Never touch client classes (rendering, screens, keybinds) from common code. A dedicated server crashes with `ClassNotFoundException`/`NoClassDefFoundError` the moment it loads one.
- Prefer a Fabric API event (`ServerLifecycleEvents`, `ServerTickEvents`, `UseBlockCallback`, `ClientTickEvents`…) over a mixin when one exists.
- Mixins: target names must match the names the game uses for that version. On 26.x, read them from the real game classes. Loom's `./gradlew genSources` decompiles them, or use `javap -p` on the class in the Loom cache. On ≤1.21.11, use the Yarn names for the exact `yarn_mappings` build. Keep injections small (`@Inject` with an explicit `@At`), and remember descriptors change between versions.
- Porting from ≤1.21.11 to 26.x is a rename to Mojang names across the whole mod, plus the build changes in the table above. Fabric API module and event names mostly stay the same.

## 5. Reading a crash

- `NoSuchMethodError`/`NoSuchFieldError`/`AbstractMethodError`: built against a different Minecraft or Fabric API than the one running. Compare `minecraft_version`/`fabric_api_version` with their launcher.
- `InvalidInjectionException` / `Critical injection failure`: a mixin target or descriptor is wrong for this version. The log names the mixin and the target.
- "Incompatible mods found" / "requires version X of fabric-api": the fix is in their `mods/` folder, not the code. Name the exact mod and version needed.
- A crash right after a port to 26.x mentioning `remap`/`intermediary`: they're still using the `-remap` plugin or `modImplementation`.

## 6. What you say when you hand over a jar

Say exactly what you checked: "built against Minecraft <x>, loader <y>, Fabric API <z>, and a dedicated server booted with it". Never say "verified" or "should work" without an in-game test, and say plainly when it is untested in-game. Give each jar a new `version`, and tell them to delete the old jar from `mods/`. When their log contradicts your build, trust the log. Legacy Forge is the `minecraft-forge-mods` skill.
