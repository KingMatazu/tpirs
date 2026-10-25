const fs=require('fs');
const p='C:/Users/matax/Documents/tpirs/apps/api/src/routes/field.ts';
let c=fs.readFileSync(p,'utf8');
c=c.replace('    const principal = (requirePermission as any)(request, "scan:read");','    const rp:any=requirePermission; const principal:any=rp(request,"scan:read");');
fs.writeFileSync(p,c);
