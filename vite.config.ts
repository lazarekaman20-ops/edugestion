import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(({ mode }) => {
  // Détermination robuste et sécurisée du mode d'application
  // Priorité : variable d'environnement VITE_APP_MODE -> mode Vite (--mode admin/client) -> repli sûr 'client'
  const rawMode = process.env.VITE_APP_MODE || process.env.APP_MODE || (mode === 'admin' ? 'admin' : mode === 'client' ? 'client' : undefined);
  const appMode = (rawMode || '').trim().toLowerCase() === 'admin' ? 'admin' : 'client';

  return {
    base: '/',
    define: {
      'import.meta.env.VITE_APP_MODE': JSON.stringify(appMode),
      '__APP_MODE__': JSON.stringify(appMode),
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'prune-unused-aistudio-dist-assets',
        closeBundle() {
          const unusedDistAssets = path.resolve(__dirname, 'dist', 'assets', 'aistudio');
          if (fs.existsSync(unusedDistAssets)) {
            fs.rmSync(unusedDistAssets, { recursive: true, force: true });
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      allowedHosts: true as const,
      // HMR websocket désactivé pour éviter les erreurs de connexion proxy/container
      hmr: false,
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    preview: {
      port: 3000,
      host: '0.0.0.0',
      allowedHosts: true as const,
    },
    build: {
      chunkSizeWarningLimit: 2500,
      reportCompressedSize: false,
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
                return 'vendor-react';
              }
              if (id.includes('lucide-react') || id.includes('motion')) {
                return 'vendor-ui';
              }
              if (id.includes('jspdf') || id.includes('xlsx') || id.includes('html2canvas') || id.includes('dompurify') || id.includes('canvg')) {
                return 'vendor-export';
              }
              if (id.includes('recharts') || id.includes('d3')) {
                return 'vendor-charts';
              }
              if (id.includes('tweetnacl') || id.includes('qrcode') || id.includes('jsbarcode')) {
                return 'vendor-crypto';
              }
              return 'vendor-misc';
            }
            if (id.includes('/src/components/admin/')) {
              return 'app-admin';
            }
            if (id.includes('/src/components/Comptabilite') || id.includes('/src/components/finance/')) {
              return 'app-finance';
            }
            if (id.includes('/src/components/CartesEtCertificats') || id.includes('/src/components/cards/')) {
              return 'app-cards';
            }
            if (id.includes('/src/components/InstallationExportView') || id.includes('/src/components/SchoolModulesView') || id.includes('/src/components/TimetableCustomizerView')) {
              return 'app-modules';
            }
          },
        },
      },
    },
  };
});
