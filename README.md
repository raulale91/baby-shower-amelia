# 🐰 Baby Shower Amelia

Invitación digital para el Baby Shower de Amelia — diseño paper craft pastel.

## Stack
- **Frontend:** HTML5 + CSS3 + JavaScript (paper craft layers, pastel girl theme)
- **Backend:** Node.js + Express + Baileys (WhatsApp panel)
- **Servidor:** Nginx (Docker) en boda-server · `testdeinvitacion.ddns.net`

## URL
`https://testdeinvitacion.ddns.net/?id=<ID_INVITADO>`

## Panel Admin
`https://testdeinvitacion.ddns.net/admin/`

| Campo | Valor |
|---|---|
| Usuario | `amanda` |
| Contraseña | `ameliashower2025` |

## Estructura
```
frontend/   → index.html (invitación web)
backend/    → server.js + panel admin WhatsApp
```

## Despliegue en servidor
```bash
# Frontend → /home/ubuntu/ameliashower/
# Backend  → /home/ubuntu/admin-amelia/
docker run -d --name whatsapp_admin_amelia --restart unless-stopped \
  -p 3004:3000 -v /home/ubuntu/admin-amelia:/app -w /app \
  node:20 node server.js
```
