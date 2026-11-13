The PDF exporter uses the unchanged html2pdf.js 0.10.1 bundle, stored locally so
loading the page and exporting PDFs do not depend on a third-party CDN.

Source: https://github.com/eKoopmans/html2pdf.js/blob/v0.10.1/dist/html2pdf.bundle.min.js

SHA-256: `85e6ee9ce246e3ae4424313f7e46a5ed860a28d757811de8dc9c43f306049d65`

The MIT license is in `html2pdf-LICENSE`; bundled dependency notices are retained
in `html2pdf.bundle.min.js.LICENSE.txt`, as referenced by the distributed JavaScript.
Country flags in `../flags/` include all 208 SVGs used by the original website's
country-code mapping. The 92 already bundled with Haute Cadence are reused;
the remaining 116 come from the official, pinned
[flag-icons v7.5.0 release](https://github.com/lipis/flag-icons/tree/v7.5.0/flags/4x3).
The matching MIT license is retained in `../flags/LICENSE`. Unknown country codes
still fall back to text.
