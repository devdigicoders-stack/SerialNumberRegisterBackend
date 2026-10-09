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
    crNumber: {
      type: String,
      trim: true,
      default: ''
    },
    barcodes: {
      type: [String],
      default: []
    },
    barcode: {
      type: String,
      trim: true
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

// Helper function to extract barcode list from a record (backwards compatible)
function getRecordBarcodes(r) {
  if (Array.isArray(r.barcodes) && r.barcodes.length > 0) {
    return r.barcodes.map((b) => String(b).trim()).filter(Boolean);
  }
  if (r.barcode && String(r.barcode).trim()) {
    return [String(r.barcode).trim()];
  }
  return [];
}

// Helper function to compute duplicate vs unique stats
function computeMetrics(records) {
  const frequencyMap = {};
  records.forEach((r) => {
    const list = getRecordBarcodes(r);
    list.forEach((code) => {
      if (code) {
        frequencyMap[code] = (frequencyMap[code] || 0) + 1;
      }
    });
  });

  const totalRecords = records.length;
  const uniqueSerials = Object.keys(frequencyMap).length;

  let duplicateEntries = 0;
  let uniqueOnlyCount = 0;

  records.forEach((r) => {
    const list = getRecordBarcodes(r);
    let hasDup = false;
    list.forEach((code) => {
      if ((frequencyMap[code] || 0) > 1) {
        hasDup = true;
      }
    });

    if (hasDup) {
      duplicateEntries++;
    } else {
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

// Enrich a single record with barcode details & duplicate counts
function enrichRecord(r, frequencyMap) {
  const list = getRecordBarcodes(r);
  let uniqueCount = 0;
  let duplicateCount = 0;

  const barcodeDetails = list.map((code) => {
    const count = frequencyMap[code] || 1;
    const isDup = count > 1;
    if (isDup) duplicateCount++;
    else uniqueCount++;
    return {
      code,
      count,
      isDuplicate: isDup
    };
  });

  const isDuplicate = duplicateCount > 0;

  return {
    id: r.id || (r._id ? r._id.toString() : ''),
    name: r.name,
    crNumber: r.crNumber || '',
    barcodes: list,
    barcode: list[0] || '',
    barcodeDetails,
    totalScans: list.length,
    uniqueCount,
    duplicateCount,
    isDuplicate,
    timestamp: r.timestamp || r.createdAt
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

    const { frequencyMap, stats } = computeMetrics(rawRecords);

    // Enrich records with occurrence count, barcode details, and duplicate flags
    const enrichedRecords = rawRecords.map((r) => enrichRecord(r, frequencyMap));

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

// 3. Add New Patient Entry with all scanned barcodes in a single record (or group by CR Number if exists)
app.post('/api/records', async (req, res) => {
  try {
    const { name, crNumber, barcode, barcodes } = req.body;

    // Normalize barcodes list
    let barcodeList = [];
    if (Array.isArray(barcodes)) {
      barcodeList = barcodes.map((b) => String(b).trim()).filter(Boolean);
    } else if (barcode) {
      const clean = String(barcode).trim();
      if (clean) barcodeList.push(clean);
    }

    if (!name || barcodeList.length === 0) {
      return res.status(400).json({ error: 'Name and at least one Barcode are required.' });
    }

    const cleanName = String(name).trim();
    const cleanCrNumber = crNumber ? String(crNumber).trim() : '';

    let recordToReturn;
    let isMerged = false;

    // If CR Number is provided, check if a record with the same CR Number already exists
    if (cleanCrNumber) {
      const escapedCr = cleanCrNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const existingRecord = await Record.findOne({
        crNumber: { $regex: new RegExp(`^${escapedCr}$`, 'i') }
      });

      if (existingRecord) {
        // Group / mix newly scanned barcodes into existing record
        const existingBarcodes = getRecordBarcodes(existingRecord);
        const combinedBarcodes = [...existingBarcodes, ...barcodeList];

        existingRecord.barcodes = combinedBarcodes;
        existingRecord.barcode = combinedBarcodes[0] || '';
        if (cleanName && cleanName !== existingRecord.name) {
          existingRecord.name = cleanName;
        }
        existingRecord.timestamp = new Date();

        const saved = await existingRecord.save();
        recordToReturn = saved;
        isMerged = true;
      }
    }

    if (!isMerged) {
      // Create a SINGLE record containing the patient name, CR number, and all scanned barcodes
      const newRecord = new Record({
        name: cleanName,
        crNumber: cleanCrNumber,
        barcodes: barcodeList,
        barcode: barcodeList[0] || '',
        timestamp: new Date()
      });

      const saved = await newRecord.save();
      recordToReturn = saved;
    }

    // Get all records to re-compute updated stats
    const allRecords = await Record.find().sort({ createdAt: -1 }).lean();
    const { frequencyMap, stats } = computeMetrics(allRecords);

    const enrichedSaved = enrichRecord(recordToReturn.toJSON(), frequencyMap);

    res.status(201).json({
      success: true,
      merged: isMerged,
      record: enrichedSaved,
      isDuplicate: enrichedSaved.isDuplicate,
      stats
    });
  } catch (err) {
    console.error('Error adding record:', err);
    res.status(500).json({ error: 'Failed to save record to database.' });
  }
});

// 4. Update Entry (Edit Name, CR Number, or Barcodes)
app.put('/api/records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, crNumber, barcode, barcodes } = req.body;

    let barcodeList = [];
    if (Array.isArray(barcodes)) {
      barcodeList = barcodes.map((b) => String(b).trim()).filter(Boolean);
    } else if (barcode) {
      const clean = String(barcode).trim();
      if (clean) barcodeList.push(clean);
    }

    if (!name || barcodeList.length === 0) {
      return res.status(400).json({ error: 'Name and at least one Barcode are required.' });
    }

    const updated = await Record.findByIdAndUpdate(
      id,
      {
        name: String(name).trim(),
        crNumber: crNumber !== undefined ? String(crNumber).trim() : '',
        barcodes: barcodeList,
        barcode: barcodeList[0] || ''
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    // Get updated metrics
    const allRecords = await Record.find().lean();
    const { frequencyMap, stats } = computeMetrics(allRecords);

    const enrichedUpdated = enrichRecord(updated.toJSON(), frequencyMap);

    res.json({
      success: true,
      message: 'Record updated successfully.',
      record: enrichedUpdated,
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
