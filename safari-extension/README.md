# Neutralens for Safari

**Patent Pending.**

The same `extension/` MV3 source is converted into a Safari Web Extension
using Apple's official `safari-web-extension-converter` Xcode command-line
tool.

> Requires macOS 13+ with Xcode 15+ installed. 
> — Apple's converter only ships on macOS.

## One-time conversion

```bash
# From the repo root on a Mac:
xcrun safari-web-extension-converter \
  ./extension \
  --project-location ./safari-extension/build \
  --app-name "Neutralens" \
  --bundle-identifier app.neutralens.safari \
  --swift \
  --no-prompt \
  --copy-resources
```

This produces an Xcode project at `safari-extension/build/Neutralens/`
containing both the macOS host app and the Safari Web Extension target.

## Build & enable

1. Open the generated Xcode project.
2. Pick your Apple Developer team under **Signing & Capabilities** for both
   the host app and the extension targets.
3. Build & run the host app once. macOS will register the Safari
   extension.
4. In Safari, go to **Settings → Extensions** and enable
   "Neutralens".
5. Visit your deployed Neutralens site, sign in, then open
   `/extension/link` to hand off the auth token to the extension.

## Updating after extension changes

Re-run the same `xcrun safari-web-extension-converter` command with the
`--rebuild-project` flag — it will overwrite the Safari project from the
updated MV3 source.

## iOS

The same Xcode project can target iOS; switch the active scheme from
"Neutralens (macOS)" to "Neutralens (iOS)" and build to a device or
simulator. The web extension surfaces through Safari's content-blocker
settings on iOS 15+.
