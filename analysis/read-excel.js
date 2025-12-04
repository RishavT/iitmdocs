/**
 * Read Excel file and convert to JSON
 */
const fs = require('fs');
const XLSX = require('xlsx');

const filename = process.argv[2] || 'manual-feedback.xlsx';

try {
  const workbook = XLSX.readFile(filename);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  // Convert to JSON
  const data = XLSX.utils.sheet_to_json(worksheet);

  console.log('Total rows:', data.length);
  console.log('\nHeaders:', Object.keys(data[0] || {}));
  console.log('\nFirst 3 rows:');
  console.log(JSON.stringify(data.slice(0, 3), null, 2));

  // Save to JSON
  fs.writeFileSync('manual-feedback.json', JSON.stringify(data, null, 2));
  console.log('\n✅ Saved to manual-feedback.json');

} catch (error) {
  console.error('Error reading Excel:', error.message);
  process.exit(1);
}
