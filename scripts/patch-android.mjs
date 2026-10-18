// After `npx cap add android`: app icon, dark window colors, file sharing from the app folder, saving to the
// phone's Download / Pictures folders, and the version from web/js/version.js.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const app = path.join(root, 'android', 'app');
const res = path.join(app, 'src', 'main', 'res');
const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// version
const versionJs = read(path.join(root, 'web', 'js', 'version.js'));
const version = versionJs.match(/VERSION\s*=\s*'([^']+)'/)[1];
const code = Number(process.env.VERSION_CODE || process.env.GITHUB_RUN_NUMBER || 1);
const gradleFile = path.join(app, 'build.gradle');
let gradle = read(gradleFile);
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
write(gradleFile, gradle);
console.log(`version ${version} (${code})`);

// icons
const iconSrc = path.join(root, 'android-res');
for (const dir of fs.readdirSync(iconSrc)) {
  if (dir.startsWith('splash')) continue;
  fs.cpSync(path.join(iconSrc, dir), path.join(res, dir), { recursive: true });
}
// splash screens: the template's Capacitor logo becomes this app's icon on the dark background
for (const dir of fs.readdirSync(res)) {
  const file = path.join(res, dir, 'splash.png');
  if (!dir.startsWith('drawable') || !fs.existsSync(file)) continue;
  fs.copyFileSync(path.join(iconSrc, dir.includes('land') ? 'splash-land.png' : 'splash-port.png'), file);
}
write(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`);
write(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), read(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml')));
// a launcher icon left over from the template that we do not provide (keeps the build from mixing two icons)
for (const dir of fs.readdirSync(res)) {
  const stale = path.join(res, dir, 'ic_launcher_background.png');
  if (fs.existsSync(stale)) fs.rmSync(stale);
}

// dark window behind the page (status bar and navigation bar too)
write(path.join(res, 'values', 'app_colors.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="app_bg">#0B0D12</color>
</resources>
`);
const stylesFile = path.join(res, 'values', 'styles.xml');
let styles = read(stylesFile);
const darkItems = `
        <item name="android:windowBackground">@color/app_bg</item>
        <item name="android:statusBarColor">@color/app_bg</item>
        <item name="android:navigationBarColor">@color/app_bg</item>
        <item name="android:windowLightStatusBar">false</item>
        <item name="android:windowLightNavigationBar">false</item>`;
styles = styles.replace(/(<style name="AppTheme\.NoActionBar"[^>]*>)/, `$1${darkItems}`);
styles = styles.replace(/(<style name="AppTheme"[^>]*>)/, `$1${darkItems}`);
styles = styles.replace(/(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)/, `$1
        <item name="windowSplashScreenBackground">@color/app_bg</item>
        <item name="android:windowBackground">@color/app_bg</item>`);
write(stylesFile, styles);

// share files from the app's own folder (pictures and exports live there)
const pathsFile = path.join(res, 'xml', 'file_paths.xml');
let paths = fs.existsSync(pathsFile) ? read(pathsFile) : '<?xml version="1.0" encoding="utf-8"?>\n<paths xmlns:android="http://schemas.android.com/apk/res/android">\n</paths>\n';
if (!paths.includes('<files-path')) paths = paths.replace('</paths>', '    <files-path name="app_files" path="." />\n</paths>');
if (!paths.includes('<cache-path')) paths = paths.replace('</paths>', '    <cache-path name="app_cache" path="." />\n</paths>');
if (!paths.includes('<external-path')) paths = paths.replace('</paths>', '    <external-path name="external" path="." />\n</paths>');
write(pathsFile, paths);

// manifest: old Android versions need storage permission to write to Download / Pictures
const manifestFile = path.join(app, 'src', 'main', 'AndroidManifest.xml');
let manifest = read(manifestFile);
const perms = [
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-permission android:name="android.permission.WAKE_LOCK" />',
];
for (const p of perms) if (!manifest.includes(p.split('"')[1])) manifest = manifest.replace(/(<manifest[^>]*>)/, `$1\n    ${p}`);
if (!manifest.includes('requestLegacyExternalStorage')) manifest = manifest.replace('<application', '<application\n        android:requestLegacyExternalStorage="true"');
write(manifestFile, manifest);
// keep the screen on while images are being made: a tiny plugin of this app (ScreenAwake.set({ on }))
const config = JSON.parse(read(path.join(root, 'capacitor.config.json')));
const pkg = config.appId;
const javaDir = path.join(app, 'src', 'main', 'java', ...pkg.split('.'));
write(path.join(javaDir, 'ScreenAwakePlugin.java'), `package ${pkg};

import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenAwake")
public class ScreenAwakePlugin extends Plugin {
    @PluginMethod
    public void set(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }
}
`);
write(path.join(javaDir, 'MainActivity.java'), `package ${pkg};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScreenAwakePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);
console.log('android project patched');
