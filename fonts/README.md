# Custom Fonts

Place `.ttf`, `.otf`, `.woff`, or `.woff2` font files in this directory.

These fonts will be included in the Document Server image alongside the Microsoft core fonts (Arial, Times New Roman, Calibri, etc.). The default ONLYOFFICE core-fonts bundle is excluded.

After adding or removing fonts, rebuild the DS Docker image. The build runs `documentserver-generate-allfonts.sh` to index them automatically.
