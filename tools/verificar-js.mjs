/* Verificador de sintaxis JS para los HTML del frontend.
   Extrae cada bloque <script> embebido (sin src) y lo pasa por `node --check`.
   Sirve para validar ediciones a mano en archivos grandes: si un paren o una
   llave queda desbalanceada, esto lo dice con el numero de linea del HTML. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const archivo = process.argv[2];
const salida = process.argv[3] || path.join(process.cwd(), '_chkjs_tmp');

const html = fs.readFileSync(archivo, 'utf8');
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
fs.mkdirSync(salida, { recursive: true });

let m;
let bloque = 0;
let fallas = 0;

while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  const cuerpo = m[2] || '';
  if (/\bsrc\s*=/.test(attrs)) continue;
  if (cuerpo.trim() === '') continue;

  bloque += 1;
  const esModulo = /type\s*=\s*["']module["']/.test(attrs);
  const destino = path.join(salida, `bloque${bloque}${esModulo ? '.mjs' : '.js'}`);
  fs.writeFileSync(destino, cuerpo, 'utf8');

  const lineaHtml = html.slice(0, m.index).split('\n').length;
  try {
    execFileSync(process.execPath, ['--check', destino], { stdio: 'pipe' });
  } catch (e) {
    fallas += 1;
    const detalle = String(e.stderr || e.stdout || e.message).split('\n').slice(0, 14).join('\n');
    console.log(`FALLA bloque ${bloque} (${esModulo ? 'module' : 'script'}) arranca en HTML linea ${lineaHtml}`);
    console.log(detalle);
  }
}

console.log(`archivo=${path.basename(archivo)} bloques=${bloque} fallas=${fallas}`);
process.exit(fallas === 0 ? 0 : 1);
