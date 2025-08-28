# 📩 API de Envío de Mensajes de WhatsApp

Este proyecto implementa un **endpoint `/sendMessage`** que permite enviar mensajes de WhatsApp a través de la API de **Baileys**.  
Está diseñado para integrarse fácilmente con **n8n** u otras plataformas de automatización mediante solicitudes HTTP.

---

## 🚀 Características

- Envío de mensajes de texto a usuarios de WhatsApp.
- Integración directa con flujos de **n8n** usando nodos HTTP Request.
- Fácil configuración y despliegue.
- Respuestas en formato JSON.

---

---

## ⚙️ Requisitos Previos

- **Node.js** v18 o superior
- **npm** o **yarn**
- Una sesión activa de **Baileys** para WhatsApp
- Tener configuradas las variables de entorno en un archivo `.env`

---

## 📦 Instalación

1. Clonar el repositorio:
   ```bash
   git clone https://github.com/YonierGM/WhatsApp_Baileys
   cd WhatsApp_Baileys
   ```

---

2. Instalar dependencias:
   ```bash
   npm install
   ```

---

3. Configurar el archivo .env

```bash
 WEBHOOK_URL=tu_webhook_aqui
 DATABASE_URL=tu_databaseurl_aqui
 PORT=3000
```
