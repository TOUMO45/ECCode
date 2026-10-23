<?php
// Runtime include tracer (PHP). Loaded through auto_prepend_file by
// `eccode impact --trace`: a stream wrapper for file:// sees every include and
// require as it is opened - paths built at runtime and autoloaders triggered
// by `new $class` included - and appends the in-project file with its
// in-project includer to ECCODE_TRACE_FILE. All real I/O is delegated to PHP's
// native file wrapper; tracing must never break the traced program.

if (getenv('ECCODE_TRACE_FILE') && getenv('ECCODE_TRACE_ROOT') && !class_exists('EccodeTraceStream', false)) {
    final class EccodeTraceStream
    {
        public $context;
        private $fp;
        private $dir;
        public static $out;
        public static $roots = array();

        private static function native(callable $fn)
        {
            stream_wrapper_restore('file');
            try {
                return $fn();
            } finally {
                stream_wrapper_unregister('file');
                stream_wrapper_register('file', __CLASS__);
            }
        }

        private static function norm($p)
        {
            return str_replace('\\', '/', $p);
        }

        // Project-relative path for either spelling of the root (8.3 short or
        // long on Windows, compared case-insensitively there); null outside.
        private static function rel($p)
        {
            $win = DIRECTORY_SEPARATOR === '\\';
            foreach (self::$roots as $r) {
                if ($win ? stripos($p, $r) === 0 : strpos($p, $r) === 0) {
                    return substr($p, strlen($r));
                }
            }
            return null;
        }

        private static function log($path)
        {
            $target = self::norm((string) realpath($path));
            $to = $target === '' ? null : self::rel($target);
            if ($to === null) {
                return;
            }
            $from = null;
            foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS) as $frame) {
                $f = isset($frame['file']) ? self::norm($frame['file']) : '';
                if ($f !== '' && $f !== $target && $f !== self::norm(__FILE__) && self::rel($f) !== null) {
                    $from = self::rel($f);
                    break;
                }
            }
            $rec = array('to' => $to);
            if ($from !== null) {
                $rec['from'] = $from;
            }
            $out = self::$out;
            self::native(function () use ($out, $rec) {
                @file_put_contents($out, json_encode($rec) . "\n", FILE_APPEND);
            });
        }

        public function stream_open($path, $mode, $options, &$opened)
        {
            $usePath = (bool) ($options & STREAM_USE_PATH);
            $ctx = $this->context;
            $this->fp = self::native(function () use ($path, $mode, $usePath, $ctx) {
                return $ctx ? @fopen($path, $mode, $usePath, $ctx) : @fopen($path, $mode, $usePath);
            });
            $forInclude = defined('STREAM_OPEN_FOR_INCLUDE') ? STREAM_OPEN_FOR_INCLUDE : 128;
            if ($this->fp && ($options & $forInclude)) {
                try {
                    self::log($path);
                } catch (\Throwable $e) {
                    // never break the traced program
                }
            }
            return (bool) $this->fp;
        }

        public function stream_read($n) { return fread($this->fp, $n); }
        public function stream_write($d) { return fwrite($this->fp, $d); }
        public function stream_eof() { return feof($this->fp); }
        public function stream_tell() { return ftell($this->fp); }
        public function stream_seek($o, $w) { return fseek($this->fp, $o, $w) === 0; }
        public function stream_flush() { return fflush($this->fp); }
        public function stream_close() { if ($this->fp) { fclose($this->fp); } }
        public function stream_stat() { return fstat($this->fp); }
        public function stream_lock($op) { return flock($this->fp, $op); }
        public function stream_truncate($n) { return ftruncate($this->fp, $n); }
        public function stream_set_option($option, $a1, $a2) { return false; }
        public function stream_cast($as) { return $this->fp; }

        public function url_stat($path, $flags)
        {
            return self::native(function () use ($path, $flags) {
                $quiet = (bool) ($flags & STREAM_URL_STAT_QUIET);
                if ($flags & STREAM_URL_STAT_LINK) {
                    return $quiet ? @lstat($path) : lstat($path);
                }
                return $quiet ? @stat($path) : stat($path);
            });
        }

        public function stream_metadata($path, $option, $value)
        {
            return self::native(function () use ($path, $option, $value) {
                switch ($option) {
                    case STREAM_META_TOUCH: return empty($value) ? touch($path) : touch($path, $value[0], $value[1]);
                    case STREAM_META_OWNER_NAME:
                    case STREAM_META_OWNER: return chown($path, $value);
                    case STREAM_META_GROUP_NAME:
                    case STREAM_META_GROUP: return chgrp($path, $value);
                    case STREAM_META_ACCESS: return chmod($path, $value);
                }
                return false;
            });
        }

        public function unlink($path) { return self::native(function () use ($path) { return unlink($path); }); }
        public function rename($a, $b) { return self::native(function () use ($a, $b) { return rename($a, $b); }); }
        public function mkdir($p, $m, $o) { return self::native(function () use ($p, $m, $o) { return mkdir($p, $m, (bool) ($o & STREAM_MKDIR_RECURSIVE)); }); }
        public function rmdir($p, $o) { return self::native(function () use ($p) { return rmdir($p); }); }
        public function dir_opendir($p, $o) { $this->dir = self::native(function () use ($p) { return opendir($p); }); return (bool) $this->dir; }
        public function dir_readdir() { return readdir($this->dir); }
        public function dir_rewinddir() { rewinddir($this->dir); return true; }
        public function dir_closedir() { closedir($this->dir); return true; }
    }

    EccodeTraceStream::$out = getenv('ECCODE_TRACE_FILE');
    foreach (array(getenv('ECCODE_TRACE_ROOT'), getenv('ECCODE_TRACE_ROOT_ALT')) as $r) {
        if ($r) {
            EccodeTraceStream::$roots[] = str_replace('\\', '/', $r);
        }
    }
    stream_wrapper_unregister('file');
    stream_wrapper_register('file', 'EccodeTraceStream');
}
