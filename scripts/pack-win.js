const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const { downloadArtifact } = require("@electron/get");
const asar = require("@electron/asar");

const root = path.join(__dirname, "..");
const version = require(path.join(root, "node_modules", "electron", "package.json")).version;

async function main() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "innnorsk-app-"));
  const dist = path.join(root, "dist");
  const appDir = path.join(dist, "InnNorsk-win32-x64");
  fs.mkdirSync(dist, { recursive: true });
  fs.rmSync(appDir, { recursive: true, force: true });

  // Bare det Electron-appen trenger: ikke server/, web/, test/ eller data/.
  for (const name of ["package-lock.json", "src", "LICENSE", "README.md"]) {
    execSync(`cp -R ${JSON.stringify(path.join(root, name))} ${JSON.stringify(stage)}`);
  }
  // express brukes bare av skyserveren.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  delete pkg.dependencies.express;
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  fs.mkdirSync(path.join(stage, "assets"));
  for (const name of ["icon.png", "icon.ico", "icon.icns"]) {
    fs.copyFileSync(path.join(root, "assets", name), path.join(stage, "assets", name));
  }

  // --omit=optional: canvas (valgfri for pdfjs-dist) ville blitt bygget for byggmaskinen, ikke Windows.
  execSync("npm install --omit=dev --omit=optional --no-fund --no-audit", { cwd: stage, stdio: "inherit" });

  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: "win32",
    arch: "x64",
  });

  fs.mkdirSync(appDir, { recursive: true });
  execSync(`unzip -q ${JSON.stringify(zipPath)} -d ${JSON.stringify(appDir)}`);

  const defaultApp = path.join(appDir, "resources", "default_app.asar");
  if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp);

  const asarPath = path.join(appDir, "resources", "app.asar");
  await asar.createPackage(stage, asarPath);

  fs.renameSync(path.join(appDir, "electron.exe"), path.join(appDir, "InnNorsk.exe"));
  fs.copyFileSync(
    path.join(root, "packaging", "START-HER.txt"),
    path.join(appDir, "START-HER.txt")
  );

  const outZip = path.join(dist, "InnNorsk-Windows.zip");
  if (fs.existsSync(outZip)) fs.unlinkSync(outZip);
  execSync(`zip -r -q InnNorsk-Windows.zip InnNorsk-win32-x64`, { cwd: dist });

  fs.rmSync(stage, { recursive: true, force: true });
  const mb = Math.round(fs.statSync(outZip).size / 1024 / 1024);
  console.log(`Windows-app: ${appDir}`);
  console.log(`Zip: ${outZip} (${mb} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
