const fs = require('fs');
const path = require('path');
const { minify } = require('html-minifier-terser');

const inputDir = path.join(__dirname, 'src');
const outputDir = path.join(__dirname, 'public');

// 1. Create the public folder if it doesn't exist yet
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
}

// 2. Set the aggressive minification rules
const minifyOptions = {
    collapseWhitespace: true,      // Removes empty lines and spaces
    removeComments: true,          // Strips out your comments
    minifyCSS: true,               // Compresses the <style> blocks
    minifyJS: true,                // Compresses the <script> blocks
    removeRedundantAttributes: false,
    removeEmptyAttributes: true
};

// 3. The engine that processes the files
async function compressFiles() {
    try {
        const files = fs.readdirSync(inputDir);
        
        for (const file of files) {
            // Only process HTML files
            if (file.endsWith('.html')) {
                const inputPath = path.join(inputDir, file);
                const outputPath = path.join(outputDir, file);
                
                const rawHtml = fs.readFileSync(inputPath, 'utf8');
                
                // Compress it!
                const minifiedHtml = await minify(rawHtml, minifyOptions);
                
                // Save it!
                fs.writeFileSync(outputPath, minifiedHtml);
                console.log(`✅ Minified: ${file}`);
            }
        }
        console.log("🚀 All files successfully compressed and moved to /public!");
    } catch (err) {
        console.error("❌ Minification failed:", err);
    }
}

compressFiles();