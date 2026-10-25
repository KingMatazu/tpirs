const fs=require('fs');
const p='C:/Users/matax/Documents/tpirs/apps/api/src/routes/field.ts';
let c=fs.readFileSync(p,'utf8');
c=c.replace(/\r?\n    \)\(\);\r?\n    \},/g,'\n    });\n    },');
fs.writeFileSync(p,c);
