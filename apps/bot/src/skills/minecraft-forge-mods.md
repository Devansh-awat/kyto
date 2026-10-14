---
name: minecraft-forge-mods
description: Build, patch or debug a Minecraft Forge mod or coremod (1.12.2 and other legacy Forge versions) in the sandbox — compiling against the REAL Forge, launchwrapper and Minecraft jars, ASM class transformers, obfuscated names, jar manifests. Use whenever a jar someone will load into a Minecraft client or server is being made or fixed.
---

# Minecraft Forge mods and coremods

Someone restarts their game for every jar you hand them, so a wrong jar costs them minutes and patience. One afternoon went through ten "verified" jars that each failed on the real client. Every failure came from testing against hand-written stubs. **Never compile or test against stubs of Forge or Minecraft classes. Download the real jars.**

## 1. Toolchain (no root, so no apt)

```bash
mkdir -p ~/jvm ~/mc && cd ~/jvm
[ -x ~/jvm/jdk8/bin/javac ] || { curl -sfL -o jdk8.tgz 'https://api.adoptium.net/v3/binary/latest/8/ga/linux/x64/jdk/hotspot/normal/eclipse' && mkdir jdk8 && tar xzf jdk8.tgz -C jdk8 --strip-components=1 && rm jdk8.tgz; }
export PATH=~/jvm/jdk8/bin:$PATH
```

Use JDK 8 for 1.12.2 and older (`--release 8` is not enough when the game runs on Java 8). For other versions, swap the major in the Adoptium URL.

## 2. The real jars (1.12.2; cached in ~/mc)

```bash
cd ~/mc
get() { [ -s "$2" ] || curl -sfL -o "$2" "$1"; }
get https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-universal.jar forge.jar
get https://libraries.minecraft.net/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar launchwrapper.jar
get https://repo1.maven.org/maven2/org/ow2/asm/asm-debug-all/5.2/asm-debug-all-5.2.jar asm.jar
get https://launcher.mojang.com/v1/objects/0f275bc1547d01fa5f56ba34bdc87d981ee12daf/client.jar client.jar
get https://maven.minecraftforge.net/de/oceanlabs/mcp/mcp/1.12.2/mcp-1.12.2-srg.zip srg.zip && unzip -o -q srg.zip joined.srg
```

Compile with `-cp ~/mc/forge.jar:~/mc/launchwrapper.jar:~/mc/asm.jar:<the target mod's jar>`. For another mod's classes (Apotheosis and the like), ask for the exact jar the person runs, or download that exact version, and put it on the classpath.

## 3. Coremod facts that broke real builds

- `IFMLLoadingPlugin` is `net.minecraftforge.fml.relauncher.IFMLLoadingPlugin` on 1.8+. `cpw.mods.fml.relauncher` is 1.7.10 only, and gives NoClassDefFoundError on 1.12.2.
- The transformer must implement `net.minecraft.launchwrapper.IClassTransformer`, or you get a ClassCastException at boot.
- **Names at runtime.** By default a coremod's transformer runs BEFORE FML's deobfuscation, so it sees notch names (class `alk`, method `b`), not SRG (`func_77325_b`) or MCP (`getMaxLevel`). Annotate the plugin with `@IFMLLoadingPlugin.SortingIndex(1001)` to receive SRG names. Look names up in `joined.srg` (`grep func_77325_b ~/mc/joined.srg`). A dev environment uses MCP names, so match the name in each environment the jar must work in.
- Also annotate with `@IFMLLoadingPlugin.MCVersion("1.12.2")` and `@IFMLLoadingPlugin.Name(...)`, and with `@IFMLLoadingPlugin.TransformerExclusions({"your.package."})`, so the transformer doesn't transform itself.
- Manifest: `FMLCorePlugin: your.package.Plugin`, only when the class really implements IFMLLoadingPlugin. If the same jar also has an `@Mod` class, add `FMLCorePluginContainsFMLMods: true`, or the mod half is never loaded. Put nothing else in the manifest. Check it with `unzip -p mod.jar META-INF/MANIFEST.MF`.
- An `@Overwrite` or hook that calls the method it replaces recurses forever (StackOverflowError). Call the original logic by another path, or copy it.

## 4. Test against the real bytes

- Pull the real target class out of the jar the game loads (`unzip -p ~/mc/client.jar alk.class > alk.class` for notch names). Run your transformer's `transform(name, transformedName, bytes)` on those bytes with the real launchwrapper and ASM on the classpath. Then check the result: load it with ASM's `CheckClassAdapter`, and print the patched method with `javap -c`.
- To test SRG names (SortingIndex 1001), remap the client jar first: `java -jar SpecialSource-1.11.4-shaded.jar --in-jar ~/mc/client.jar --out-jar ~/mc/client-srg.jar --srg-in ~/mc/joined.srg` (from `https://repo1.maven.org/maven2/net/md-5/SpecialSource/1.11.4/SpecialSource-1.11.4-shaded.jar`).
- Add a log line to the transformer for "found the target method" and one for "rewrote it". Tell the person exactly which lines to look for in `latest.log`, and what it means if the first appears without the second.

## 5. What you say when you hand over a jar

- Say exactly what you checked: "compiled against Forge 14.23.5.2860, ran the transformer on the real `alk` bytes, and the method was rewritten". Never say "verified" or "should work now" when you didn't test it in an actual game. Say plainly that it is untested in-game.
- Give each jar a new version number, and tell them to delete the old jar from `mods/`. Two copies of a coremod both load.
- When their log contradicts your test, trust the log. Find out what your test did differently before you build the next jar.
