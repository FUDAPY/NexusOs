/* Busca secuencias tipicas de mojibake (UTF-8 leido como Latin-1) en un archivo.
   Imprime numero de linea y el texto, para no tener que adivinar donde esta. */
import fs from 'node:fs';

const archivo = process.argv[2];
const texto = fs.readFileSync(archivo, 'utf8');
const patron = /[\u00C3\u00C2][\u0080-\u00BF]/;

let total = 0;
texto.split('\n').forEach((linea, i) => {
  const m = linea.match(patron);
  if (m) {
    total += 1;
    console.log(`${i + 1}: ...${linea.trim().slice(0, 150)}`);
  }
});
console.log(`archivo=${archivo} lineas_sospechosas=${total}`);
