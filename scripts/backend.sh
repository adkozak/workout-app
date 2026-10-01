#!/usr/bin/env bash
# Push/deploy the Apps Script backend to the real sheet (prod) or to a copy of it (test).
#
#   scripts/backend.sh prod push|deploy
#   scripts/backend.sh test init <scriptId>   # once: wire up a copy of the sheet (see README)
#   scripts/backend.sh test push|deploy|link|qr
#   scripts/backend.sh prod qr                # setup code as a QR code in the terminal, for the watch
#
# prod uses .clasp.json, .deployment-id and apps-script/secret.js as before.
# test uses .clasp.test.json, .deployment-id.test and its own token in .secret.test,
# pushed from a build folder so the prod token never lands in the test copy.
# All of these files are gitignored.
set -euo pipefail
cd "$(dirname "$0")/.."

env=${1:?usage: backend.sh prod|test init|push|deploy|link|qr}
cmd=${2:?usage: backend.sh prod|test init|push|deploy|link|qr}

node scripts/gen.mjs apps-script

if [[ $env == prod ]]; then
  project=.clasp.json
  deployment_file=.deployment-id
elif [[ $env == test ]]; then
  project=.clasp.test.json
  deployment_file=.deployment-id.test
  build=.build/apps-script-test
  if [[ $cmd == init ]]; then
    script_id=${3:?usage: backend.sh test init <scriptId of the sheet copy>}
    [[ -f .secret.test ]] || node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))' > .secret.test
    cat > "$project" <<EOF
{
  "scriptId": "$script_id",
  "rootDir": "$build",
  "scriptExtensions": [".js", ".gs"],
  "htmlExtensions": [".html"],
  "jsonExtensions": [".json"],
  "filePushOrder": [],
  "skipSubdirectories": false
}
EOF
  fi
  [[ -f $project ]] || { echo "no $project; run: scripts/backend.sh test init <scriptId>" >&2; exit 1; }
  rm -rf "$build" && mkdir -p "$build"
  cp apps-script/*.js apps-script/appsscript.json "$build"/
  printf "var API_TOKEN = '%s';\n" "$(cat .secret.test)" > "$build/secret.js"
else
  echo "unknown environment $env" >&2; exit 1
fi

link() {
  local id token name
  id=$(cat "$deployment_file")
  if [[ $env == test ]]; then token=$(cat .secret.test); name=TEST; else token=$(sed -E "s/.*'(.*)'.*/\1/" apps-script/secret.js); name=; fi
  URL="https://script.google.com/macros/s/$id/exec" TOKEN="$token" NAME="$name" node -e '
    const cfg = { url: process.env.URL, token: process.env.TOKEN, ...(process.env.NAME ? { name: process.env.NAME } : {}) };
    const code = Buffer.from(JSON.stringify(cfg)).toString("base64url");
    console.log("web app: " + cfg.url);
    console.log("setup code (watch settings, or paste into the PWA): " + code);
    console.log("PWA link: <your PWA address>#setup=" + code);'
}

case $cmd in
  init)
    npx clasp -P "$project" push --force
    out=$(npx clasp -P "$project" create-deployment -d "test $(date -Iseconds)")
    echo "$out"
    grep -oE 'AKfy[A-Za-z0-9_-]+' <<<"$out" | head -1 > "$deployment_file"
    [[ -s $deployment_file ]] || { echo "could not read the deployment id from clasp output" >&2; exit 1; }
    link
    echo
    echo "Now open the copy's Apps Script editor, pick 'authorize' in the function list and Run it once."
    ;;
  push) npx clasp -P "$project" push --force ;;
  deploy)
    npx clasp -P "$project" push --force
    npx clasp -P "$project" update-deployment "$(cat "$deployment_file")" -d "$(date -Iseconds)"
    ;;
  link) link ;;
  qr)
    # The setup code as a QR code, to get it onto the phone: scan with the camera, copy, paste into Zepp.
    code=$(link | sed -n 's/^setup code[^:]*: //p')
    CODE="$code" node -e 'require("./watch/node_modules/qrcode-terminal").generate(process.env.CODE, { small: true })'
    echo "Scan with the phone camera (or Google Lens), copy the text, paste it into the Zepp app's settings for Workout 531."
    ;;
  *) echo "unknown command $cmd" >&2; exit 1 ;;
esac
