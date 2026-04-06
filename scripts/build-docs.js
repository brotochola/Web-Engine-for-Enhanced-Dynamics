import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Script to generate JSDoc documentation and consolidate stray js_docs_* folders.
 */

const projectRoot = process.cwd();
const mainDocsDir = path.join(projectRoot, 'js_docs');
const archiveDir = path.join(mainDocsDir, 'archive');

async function buildDocs() {
  console.log('🚀 Generating documentation...');

  try {
    // 1. Run JSDoc
    execSync('npx jsdoc src -r -d js_docs', { stdio: 'inherit' });
    console.log('✅ Documentation generated in js_docs/');

    // 2. Ensure archive directory exists
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    // 3. Find and move stray js_docs_* folders
    const items = fs.readdirSync(projectRoot);
    const strayFolders = items.filter(item => 
      item.startsWith('js_docs_') && 
      item !== 'js_docs' && 
      fs.statSync(path.join(projectRoot, item)).isDirectory()
    );

    if (strayFolders.length > 0) {
      console.log(`📦 Consolidating ${strayFolders.length} folders...`);
      for (const folder of strayFolders) {
        const source = path.join(projectRoot, folder);
        const destination = path.join(archiveDir, folder);

        // Remove destination if it already exists to allow overwrite
        if (fs.existsSync(destination)) {
          fs.rmSync(destination, { recursive: true, force: true });
        }

        fs.renameSync(source, destination);
        console.log(`   ➡️ Moved ${folder} to js_docs/archive/`);
      }
    } else {
      console.log('✨ No stray folders to consolidate.');
    }

    console.log('\n🎉 Documentation consolidated successfully!');
    console.log('Open js_docs/index.html to view.');

  } catch (error) {
    console.error('❌ Error during documentation build:', error.message);
    process.exit(1);
  }
}

buildDocs();
