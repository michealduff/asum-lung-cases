#!/bin/sh
# Adds ?v=<timestamp> to the app's own CSS/JS links in index.html so phones fetch the
# new files after each update instead of using an old saved copy. Run before publishing.
cd "$(dirname "$0")/.." || exit 1
v=$(date +%Y%m%d%H%M%S)
sed -i '' -E "s#(href|src)=\"(styles\.css|config\.js|template\.js|store\.js|word\.js|app\.js)(\?v=[0-9]+)?\"#\1=\"\2?v=$v\"#g" index.html
echo "Stamped version $v"
