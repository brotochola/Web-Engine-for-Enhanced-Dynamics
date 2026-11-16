# The cost of the HLSL ANGLE hands Direct3D for a WebGL program (E-406): compiles each <name>.hlsl that
# tests/bench/angleHlslDump.mjs wrote (its "COMPILER INPUT HLSL" section, the text ANGLE gives D3DCompile) with the
# system's d3dcompiler_47.dll (ps_5_0, entry main), disassembles the bytecode and reports the instruction slots, the temp
# registers (dcl_temps: the register pressure that caps how many warps the GPU keeps in flight), the texture fetches
# (sample*, ld*, gather*) and the loops. Writes <name>.asm next to each file.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/bench/d3dShaderStats.ps1 -Dir tests/results/angle-hlsl [-Level 3]
param([string]$Dir = 'tests/results/angle-hlsl', [int]$Level = 3)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("8BA5FB08-5195-40e2-AC58-0D989C3A0102"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ID3DBlob {
  [PreserveSig] IntPtr GetBufferPointer();
  [PreserveSig] UIntPtr GetBufferSize();
}

public static class D3DC {
  [DllImport("d3dcompiler_47.dll", CharSet = CharSet.Ansi)]
  static extern int D3DCompile(byte[] src, UIntPtr size, string name, IntPtr defines, IntPtr include, string entry,
    string target, uint flags1, uint flags2, out ID3DBlob code, out ID3DBlob errors);
  [DllImport("d3dcompiler_47.dll", CharSet = CharSet.Ansi)]
  static extern int D3DDisassemble(IntPtr src, UIntPtr size, uint flags, string comments, out ID3DBlob text);

  static string Text(ID3DBlob b) {
    if (b == null) return "";
    int n = (int)b.GetBufferSize().ToUInt64();
    byte[] bytes = new byte[n];
    Marshal.Copy(b.GetBufferPointer(), bytes, 0, n);
    return Encoding.ASCII.GetString(bytes).TrimEnd('\0');
  }

  public static string Compile(string source, uint flags, out string errors) {
    byte[] src = Encoding.ASCII.GetBytes(source);
    ID3DBlob code, err;
    int hr = D3DCompile(src, (UIntPtr)src.Length, "angle", IntPtr.Zero, IntPtr.Zero, "main", "ps_5_0", flags, 0, out code, out err);
    errors = Text(err);
    if (hr < 0 || code == null) return null;
    ID3DBlob asm;
    hr = D3DDisassemble(code.GetBufferPointer(), code.GetBufferSize(), 0, null, out asm);
    return hr < 0 ? null : Text(asm);
  }
}
"@

# D3DCOMPILE_OPTIMIZATION_LEVEL0..3 = 1<<14, 0, 3<<14 (level 2), 1<<15 (level 3).
$levels = @{ 0 = 0x4000; 1 = 0; 2 = 0xC000; 3 = 0x8000 }
$flags = [uint32]$levels[$Level]
$files = Get-ChildItem -Path $Dir -Filter '*.hlsl' | Sort-Object Name
foreach ($f in $files) {
  $all = Get-Content -Raw -Path $f.FullName
  $m = [regex]::Match($all, '// COMPILER INPUT HLSL BEGIN\r?\n([\s\S]*?)// COMPILER INPUT HLSL END')
  if (-not $m.Success) { Write-Output ("{0}: no COMPILER INPUT HLSL section" -f $f.BaseName); continue }
  $errors = ''
  $asm = [D3DC]::Compile($m.Groups[1].Value, $flags, [ref]$errors)
  if ($null -eq $asm) { Write-Output ("{0}: compile failed: {1}" -f $f.BaseName, (($errors -split "`n" | Select-Object -First 3) -join ' | ')); continue }
  $asmPath = [IO.Path]::ChangeExtension($f.FullName, '.asm')
  Set-Content -Path $asmPath -Value $asm -Encoding utf8
  $slots = [regex]::Match($asm, 'Approximately (\d+) instruction slots used').Groups[1].Value
  $temps = [regex]::Match($asm, 'dcl_temps (\d+)').Groups[1].Value
  $idx = ([regex]::Matches($asm, 'dcl_indexableTemp x\d+\[(\d+)\], (\d+)') | ForEach-Object { "$($_.Groups[1].Value)x$($_.Groups[2].Value)" }) -join ','
  $count = { param($re) ([regex]::Matches($asm, $re)).Count }
  $sample = & $count '(?m)^\s+(sample\w*|gather\w*)'
  $ld = & $count '(?m)^\s+ld\w*'
  $loops = & $count '(?m)^\s+loop\b'
  $ifs = & $count '(?m)^\s+if_'
  $divs = & $count '(?m)^\s+(div|rcp)\b'
  $roots = & $count '(?m)^\s+(sqrt|rsq)\b'
  Write-Output ("{0,-18} slots {1,5}  temps {2,3}  indexable {3,-8}  sample {4,3}  ld {5,3}  loops {6,2}  ifs {7,3}  div/rcp {8,3}  sqrt/rsq {9,3}" -f $f.BaseName, $slots, $temps, $idx, $sample, $ld, $loops, $ifs, $divs, $roots)
}
