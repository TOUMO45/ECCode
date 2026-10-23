# Runtime load tracer (Ruby). Loaded via RUBYOPT=-r<this file> by
# `eccode impact --trace`: every in-project file Ruby compiles - through
# require, require_relative, load, autoload or const_get-triggered autoload,
# including paths built at runtime - is appended to ECCODE_TRACE_FILE with the
# nearest in-project caller on the stack as the importer.
require 'json'

out = ENV['ECCODE_TRACE_FILE']
root = ENV['ECCODE_TRACE_ROOT']
if out && root
  win = Gem.win_platform?
  roots = [root, ENV['ECCODE_TRACE_ROOT_ALT']].compact.map { |r| r.tr('\\', '/') }
  # Project-relative path for either spelling of the root (8.3 short or long on
  # Windows, compared case-insensitively there); nil outside the project.
  rel = lambda do |p|
    p = p.tr('\\', '/')
    r = roots.find { |x| win ? p.downcase.start_with?(x.downcase) : p.start_with?(x) }
    r && p[r.length..]
  end
  this = File.expand_path(__FILE__)
  TracePoint.new(:script_compiled) do |tp|
    begin
      next if tp.eval_script # eval of a string, not a file load
      target = tp.instruction_sequence.absolute_path
      to = target && rel.call(target)
      next unless to
      from = caller_locations.map(&:absolute_path).compact.find do |p|
        p != target && p != this && rel.call(p)
      end
      rec = { 'to' => to }
      rec['from'] = rel.call(from) if from
      File.open(out, 'a') { |f| f.puts(JSON.generate(rec)) }
    rescue StandardError
      nil # tracing must never break the traced program
    end
  end.enable
end
