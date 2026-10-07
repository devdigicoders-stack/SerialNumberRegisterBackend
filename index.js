require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://devdigicoders_db_user:cYzd1OApO7oE1EUf@cluster0.4mwemnb.mongodb.net/number_register?retryWrites=true&w=majority';

// Middleware
app.use(cors());
app.use(express.json());

// ================= MONGODB CONNECTION =================
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB Atlas successfully!');
  })
  .catch((err) => {
    console.error('❌ MongoDB Connection Error:', err.message);
  });

// ================= MONGOOSE SCHEMA & MODEL =================
const recordSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    barcode: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        return ret;
      }
    }
  }
);

const Record = mongoose.model('Record', recordSchema);

// Helper function to compute duplicate vs unique stats
function computeMetrics(records) {
  const frequencyMap = {};
  records.forEach((r) => {
    const code = (r.barcode || '').trim();
    if (code) {
      frequencyMap[code] = (frequencyMap[code] || 0) + 1;
    }
  });

  const totalRecords = records.length;
  const uniqueSerials = Object.keys(frequencyMap).length;

  let duplicateEntries = 0;
  let uniqueOnlyCount = 0;

  records.forEach((r) => {
    const code = (r.barcode || '').trim();
    const count = frequencyMap[code] || 0;
    if (count > 1) {
      duplicateEntries++;
    } else if (count === 1) {
      uniqueOnlyCount++;
    }
  });

  return {
    frequencyMap,
    stats: {
      totalRecords,
      uniqueSerials,
      duplicateEntries,
      uniqueOnlyCount
    }
  };
}

// ================= API ENDPOINTS =================

// 1. Admin Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin123') {
    return res.json({
      success: true,
      message: 'Login successful',
      user: { username: 'admin', role: 'administrator' }
    });
  }
  return res.status(401).json({
    success: false,
    message: 'Invalid username or password (default: admin / admin123)'
  });
});

// 2. Get All Records & Duplicate Metrics
app.get('/api/records', async (req, res) => {
  try {
    const rawRecords = await Record.find().sort({ createdAt: -1 }).lean();

    // Map records with string id
    const records = rawRecords.map((r) => ({
      id: r._id.toString(),
      name: r.name,
      barcode: r.barcode,
      timestamp: r.timestamp || r.createdAt
    }));

    const { frequencyMap, stats } = computeMetrics(records);

    // Enrich records with occurrence count and duplicate flag
    const enrichedRecords = records.map((r) => {
      const count = frequencyMap[(r.barcode || '').trim()] || 1;
      return {
        ...r,
        count,
        isDuplicate: count > 1
      };
    });

    res.json({
      records: enrichedRecords,
      stats,
      frequencyMap
    });
  } catch (err) {
    console.error('Error fetching records:', err);
    res.status(500).json({ error: 'Failed to fetch records from database.' });
  }
});

// 3. Add New Entry
app.post('/api/records', async (req, res) => {
  try {
    const { name, barcode } = req.body;
    if (!name || !barcode) {
      return res.status(400).json({ error: 'Name and Barcode are required.' });
    }

    const cleanName = String(name).trim();
    const cleanBarcode = String(barcode).trim();

    // Check existing count in MongoDB
    const existingCount = await Record.countDocuments({ barcode: cleanBarcode });

    const newRecord = new Record({
      name: cleanName,
      barcode: cleanBarcode,
      timestamp: new Date()
    });

    const saved = await newRecord.save();

    // Get all records to re-compute updated stats
    const allRecords = await Record.find().sort({ createdAt: -1 }).lean();
    const formattedRecords = allRecords.map((r) => ({
      id: r._id.toString(),
      name: r.name,
      barcode: r.barcode,
      timestamp: r.timestamp || r.createdAt
    }));

    const { stats } = computeMetrics(formattedRecords);

    res.status(201).json({
      success: true,
      record: {
        id: saved._id.toString(),
        name: saved.name,
        barcode: saved.barcode,
        timestamp: saved.timestamp,
        count: existingCount + 1,
        isDuplicate: existingCount > 0
      },
      isDuplicate: existingCount > 0,
      stats
    });
  } catch (err) {
    console.error('Error adding record:', err);
    res.status(500).json({ error: 'Failed to save record to database.' });
  }
});

// 4. Update Entry (Edit Name or Barcode)
app.put('/api/records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, barcode } = req.body;

    if (!name || !barcode) {
      return res.status(400).json({ error: 'Name and Barcode are required.' });
    }

    const updated = await Record.findByIdAndUpdate(
      id,
      {
        name: String(name).trim(),
        barcode: String(barcode).trim()
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    // Get updated metrics
    const allRecords = await Record.find().lean();
    const formattedRecords = allRecords.map((r) => ({
      id: r._id.toString(),
      name: r.name,
      barcode: r.barcode,
      timestamp: r.timestamp || r.createdAt
    }));
    const { stats } = computeMetrics(formattedRecords);

    res.json({
      success: true,
      message: 'Record updated successfully.',
      record: {
        id: updated._id.toString(),
        name: updated.name,
        barcode: updated.barcode,
        timestamp: updated.timestamp
      },
      stats
    });
  } catch (err) {
    console.error('Error updating record:', err);
    res.status(500).json({ error: 'Failed to update record.' });
  }
});

// 5. Delete Single Entry
app.delete('/api/records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Record.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    // Get updated metrics
    const allRecords = await Record.find().lean();
    const formattedRecords = allRecords.map((r) => ({
      id: r._id.toString(),
      name: r.name,
      barcode: r.barcode,
      timestamp: r.timestamp || r.createdAt
    }));
    const { stats } = computeMetrics(formattedRecords);

    res.json({
      success: true,
      message: 'Record deleted.',
      stats
    });
  } catch (err) {
    console.error('Error deleting record:', err);
    res.status(500).json({ error: 'Failed to delete record.' });
  }
});

// 6. Clear All Entries
app.delete('/api/records', async (req, res) => {
  try {
    await Record.deleteMany({});
    res.json({
      success: true,
      message: 'All records cleared from database.',
      stats: {
        totalRecords: 0,
        uniqueSerials: 0,
        duplicateEntries: 0,
        uniqueOnlyCount: 0
      }
    });
  } catch (err) {
    console.error('Error clearing records:', err);
    res.status(500).json({ error: 'Failed to clear records.' });
  }
});

// Serve frontend in production build if present
if (process.env.NODE_ENV === 'production') {
  const clientBuildPath = path.join(__dirname, '../client/dist');
  if (require('fs').existsSync(clientBuildPath)) {
    app.use(express.static(clientBuildPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(clientBuildPath, 'index.html'));
    });
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Node.js Backend Server running on http://localhost:${PORT}`);
});
