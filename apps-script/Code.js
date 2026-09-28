function extractExerciseData() {
  // Get active spreadsheet and all sheets
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();

  // Prompt the user for the exercise name (e.g., "Squat")
  var exerciseName = Browser.inputBox("Enter exercise name (e.g., Squat)");
  if (!exerciseName) {
    Browser.msgBox("No exercise name provided. Exiting.");
    return;
  }
  
  // Define the offset values:
  // In this example, weight is 2 rows down and 1 column right,
  // and reps is 2 rows down and 2 columns right from where the exercise name is found.
  var weightOffsetRow = 7;
  var weightOffsetCol = 1;
  var repsOffsetRow = 7;
  var repsOffsetCol = 5;
  
  // Array to store found records
  var results = [];
  
  // Loop through sheets with names like "cycle1", "cycle2", ...
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    var sheetName = sheet.getName();
    if (sheetName.match(/^cycle\d+$/)) {
      var dataRange = sheet.getDataRange();
      var data = dataRange.getValues();
      
      // Loop over all cells in the sheet
      for (var r = 0; r < data.length; r++) {
        for (var c = 0; c < data[r].length; c++) {
          if (data[r][c] === exerciseName) {
            // Calculate target cell positions
            var weightRow = r + weightOffsetRow;
            var weightCol = c + weightOffsetCol;
            var repsRow = r + repsOffsetRow;
            var repsCol = c + repsOffsetCol;
            
            // Ensure the target cells are within the data bounds
            if (weightRow < data.length && weightCol < data[r].length &&
                repsRow < data.length && repsCol < data[r].length) {
              var weight = data[weightRow][weightCol];
              var reps = data[repsRow][repsCol];
              
              // Only add if both weight and reps are not empty
              if (weight !== "" && reps !== "") {
                results.push({ weight: weight, reps: reps });
              }
            }
          }
        }
      }
    }
  }
  
  // Aggregate data: For each unique weight, determine the maximum reps recorded.
  var aggregation = {};
  results.forEach(function(record) {
    // Use the weight value as a key (it can be a string or number)
    var weightKey = record.weight;
    var repsNumber = parseFloat(record.reps);
    
    // If there's no entry for this weight, or if this record's reps are higher, update the entry.
    if (aggregation[weightKey] === undefined || repsNumber > aggregation[weightKey]) {
      aggregation[weightKey] = repsNumber;
    }
  });
  
  // Prepare output data: first row for headers
  var outputData = [["Weight", "Max Reps"]];
  for (var weight in aggregation) {
    outputData.push([weight, aggregation[weight]]);
  }
  
  // Create or clear the summary sheet (named "<exerciseName> Summary")
  var summarySheetName = exerciseName + " Summary";
  var summarySheet = ss.getSheetByName(summarySheetName);
  if (!summarySheet) {
    summarySheet = ss.insertSheet(summarySheetName);
  } else {
    summarySheet.clear();
  }
  
  // Write the aggregated data to the summary sheet
  summarySheet.getRange(1, 1, outputData.length, outputData[0].length).setValues(outputData);
  
  Browser.msgBox("Data extraction complete! Check the '" + summarySheetName + "' sheet for results.");
}
