'use strict';
// Reference solution for bench/suites/followup/py-median (run inside the sandbox).
const fs = require('fs');
fs.appendFileSync('src/stats.py', [
  '',
  '',
  'def median(values):',
  '    """Median of the numeric readings, or None when there are none."""',
  '    nums = sorted(numbers(values))',
  '    if not nums:',
  '        return None',
  '    mid = len(nums) // 2',
  '    return nums[mid] if len(nums) % 2 else (nums[mid - 1] + nums[mid]) / 2',
  '',
].join('\n'));
fs.appendFileSync('test_stats.py', '\n\ndef test_median():\n    from src.stats import median\n    assert median([3, None, 1]) == 2\n');
