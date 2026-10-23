# Runtime load tracer (Ruby). Loaded via RUBYOPT=-r<this file> by
# `eccode impact --trace`: every in-project file Ruby compiles - through
# require, require_relative, load, autoload or const_get-triggered autoload,
# including paths built at runtime - is appended to ECCODE_TRACE_FILE with the
# nearest in-project caller on the stack as the importer.
require 'json'

out = ENV['ECCODE_TRACE_FILE']
root = ENV['ECCODE_TRACE_ROOT']
if out && root
  root = root.tr('\\', '/')
  this = File.expand_path(__FILE__)
  TracePoint.new(:script_compiled) do |tp|
    begin
      next if tp.eval_script # eval of a string, not a file load
      target = tp.instruction_sequence.absolute_path
      next unless target && target.start_with?(root)
      from = caller_locations.map(&:absolute_path).compact.find do |p|
        p.start_with?(root) && p != target && p != this
      end
      rec = { 'to' => target.delete_prefix(root) }
      rec['from'] = from.delete_prefix(root) if from
      File.open(out, 'a') { |f| f.puts(JSON.generate(rec)) }
    rescue StandardError
      nil # tracing must never break the traced program
    end
  end.enable
end
