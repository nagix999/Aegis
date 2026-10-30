#!/usr/bin/env node
/** Build only the existing React console. The runtime server is Python. */
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await build({
  root:resolve(project,'frontend'),configFile:false,publicDir:resolve(project,'public'),
  plugins:[react()],define:{__AEGIS_ENGINE_VERSION__:JSON.stringify('7-python')},
  resolve:{alias:{'@/lib/aegis-engine':resolve(project,'lib/workflow-validation.ts'),'@':project}},
  build:{outDir:resolve(project,'dist/python-client'),emptyOutDir:true,target:'es2022'},
});
