/**
 * Ad-hoc sign the packed bundle.
 *
 * Electron ships signed, and electron-builder then renames the executable,
 * rewrites Info.plist and drops our own files into Contents/Resources — all of
 * which invalidate that signature. `codesign --verify` on the result says
 * "code has no resources but signature indicates they must be present", and on
 * Apple silicon a bundle whose signature does not verify is not merely
 * untrusted, it will not launch at all: arm64 macOS requires *a* valid
 * signature to execute a binary, quite apart from Gatekeeper's opinion of who
 * issued it.
 *
 * An ad-hoc signature (`--sign -`) satisfies that requirement and needs no
 * Apple Developer account. It leaves the download with the "unidentified
 * developer" prompt, which the site and README both explain how to clear.
 *
 * When a real identity is configured this hook stands aside: electron-builder
 * has already signed the bundle properly, and re-signing ad-hoc would throw
 * that away.
 */
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (context.packager.platformSpecificBuildOptions.identity !== null) return;

  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  execFileSync('codesign', [
    '--force', '--deep', '--sign', '-', '--timestamp=none', appPath,
  ], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${appPath}`);
};
