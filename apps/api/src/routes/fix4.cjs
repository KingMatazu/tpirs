const fs=require('fs');
const p='C:/Users/matax/Documents/tpirs/apps/api/src/routes/field.ts';
let c=fs.readFileSync(p,'utf8');
c=c.replace('const principal: any = (requirePermission as any).call(null, request, "scan:read");','const principal: any = (requirePermission as any)(request as any);');
fs.writeFileSync(p,c);
