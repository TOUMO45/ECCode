"""Statistics for sensor readings, which arrive with gaps (None) and junk values."""


def numbers(values):
    """The numeric readings, in order: None, strings, booleans and other junk dropped."""
    return [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]


def mean(values):
    """Arithmetic mean of the numeric readings, or None when there are none."""
    nums = numbers(values)
    return sum(nums) / len(nums) if nums else None
