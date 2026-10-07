# Serial Number Register Backend (Node.js + Express + MongoDB)

REST API backend for Name & Serial / Barcode Register application.

## 🚀 Setup & Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.env`:
```env
PORT=5001
MONGO_URI=mongodb+srv://devdigicoders_db_user:cYzd1OApO7oE1EUf@cluster0.4mwemnb.mongodb.net/number_register?retryWrites=true&w=majority
```

3. Start the server:
```bash
npm start
```

## 📡 API Endpoints

- `POST /api/login` - Admin authentication
- `GET /api/records` - Get all records & live unique/duplicate statistics
- `POST /api/records` - Add new entry (Name + Barcode)
- `PUT /api/records/:id` - Update entry
- `DELETE /api/records/:id` - Delete entry
- `DELETE /api/records` - Clear all entries
