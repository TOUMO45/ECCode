"""pytest plugin for the pilot (A2): one coverage context per test.

Run under `coverage run`: before each test's setup, coverage switches to a
context named after the test's node id, so the data says which tests ran
each line. Lines run at import during collection keep the empty context.
"""
import coverage


def pytest_runtest_setup(item):
    cov = coverage.Coverage.current()
    if cov is not None:
        cov.switch_context(item.nodeid)
