const fs=require('fs');
const p='C:/Users/matax/Documents/tpirs/apps/api/src/routes/field.ts';
let c=fs.readFileSync(p,'utf8');
c=c.replace('    const rp: any = requirePermission as any;\n    const principal: any = rp(request, "scan:read");','    const principal:any = (requirePermission as any)(request as any);');
c=c.replace('    const rp: any = requirePermission as any;\r\n    const principal: any = rp(request, "scan:read");','    const principal:any = (requirePermission as any)(request as any);');
fs.writeFileSync(p,c);
